/**
 * Recursive folder copy behind the `copy` tool (files still go through
 * ops.ts `copyFile`). The tree is copied breadth-first in slices of at most
 * `maxFiles` items per call so a Vercel function never has to finish a big
 * tree in one go: each call returns an opaque `resume` cursor (base64 JSON
 * with the pending [source, destination] folder pairs, items waiting for a
 * retry and the temporary share) that the client passes back to continue.
 *
 * Cross-account, writable source: no folder is ever shared. For each file
 * the source account grants the destination account temporary `reader`
 * access to that one file (expiring, no e-mail, audited; tempgrant.ts), the
 * destination copies it server-side, and the grant is removed in a `finally`
 * before the next file. So at most one file is exposed at a time and nothing
 * lingers when a client abandons the resume cursor. A file the source may not
 * share for copying (copyRequiresWriterPermission, no sharing rights) is
 * streamed through this server instead. Same account: the same walker
 * without grants.
 *
 * Cross-account, read-only source: the whole tree is streamed (streamcopy.ts,
 * the transfer engine); nothing is written to the source account. That route
 * returns its own resume cursor, which this function recognises.
 *
 * A 404 / 429 / 5xx on one file is retried with backoff; what still fails
 * goes back into the cursor (done stays false) for up to MAX_RETRY_ROUNDS
 * resumes before it is reported as a permanent failure.
 *
 * Idempotent: a destination child with the same name (and, for binary
 * files, the same size) is skipped, so a slice that was cut short or a
 * repeated call never duplicates anything.
 */
import { isAccountReadOnly } from "./access";
import { appendAudit, type AuditEntry } from "./audit";
import { readOnlySourceReason, shareBlocker, unstreamable } from "./copyroute";
import { assertWritable, ctxFor, ownerLabel, targetFolder, toResult, type Ctx, type FileResult } from "./ctx";
import { DriveError, FOLDER_MIME, SHORTCUT_MIME, type DriveFile } from "./drive";
import { isGoogleNativeMime } from "./naming";
import type { OpMeta } from "./ops";
import { pathResolver } from "./paths";
import { CONVERTED_NOTE, isStreamCursor, streamById } from "./providers/transfer";
import { streamCopy, type StreamCopyPlan, type StreamCopyResult } from "./streamcopy";
import { grantTemporaryRead, removeTemporaryGrant, TEMP_GRANT_ROLE, TEMP_GRANT_TTL_MS, type TempGrant } from "./tempgrant";

export const DEFAULT_MAX_FILES = 150;
export const DRY_RUN_WALK_CAP = 5000;
/** Stop a slice after this long so the function returns a cursor before Vercel's limit (maxDuration 300 s). */
export const SLICE_BUDGET_MS = 240_000;
/** Backoff (ms) between attempts at one file that answered 404 / 5xx. */
export const COPY_RETRY_BACKOFF_MS = [500, 1000, 2000];
/** Resumes an item may ride along as "retryable" before it becomes a permanent failure. */
export const MAX_RETRY_ROUNDS = 3;

export interface CopyTreeArgs {
  fromAccount: string;
  fileId: string;
  toAccount: string;
  toPath?: string;
  toFolderId?: string;
  newName?: string;
  allowNonStandardName?: boolean;
  trashOriginal?: boolean;
  maxFiles?: number;
  resume?: string;
  dryRun?: boolean;
}

export interface Counts {
  copiedFiles: number;
  createdFolders: number;
  shortcuts: number;
  skipped: number;
  failed: number;
}

/** A file that failed transiently: [sourceFileId, destinationFolderId, name, roundsSoFar]. */
export type RetryItem = [string, string, string, number];

export interface Cursor {
  v: 1;
  from: string;
  fileId: string;
  to: string;
  /** Destination top folder (created or reused on the first call). */
  topDest: string;
  /** Breadth-first queue of [sourceFolderId, destinationFolderId, sourcePageToken?, itemsAlreadyHandledInThatPage?]. */
  pending: [string, string, string?, number?][];
  /** Files whose copy failed transiently (404 / 5xx) and will be tried again on the next call. */
  retry?: RetryItem[];
  /** Before 1.0.1 only: a writer share on the source top folder. Removed on the next resume. */
  share?: { permissionId: string };
  visible?: boolean;
  totals: Counts;
  /** Items left out on purpose over every slice (no export/import path when a file had to stream). */
  notCopiedTotal?: number;
}

export interface CopyFailure {
  id: string;
  name: string;
  error: string;
}

export interface CopyTreeResult extends Counts {
  kind: "folder";
  crossAccount: boolean;
  source: FileResult & { trashed: boolean };
  top: FileResult;
  topCreated: boolean;
  /** Permanent failures of this slice (not retried again). */
  failures: CopyFailure[];
  /** Transient failures of this slice; they are inside the resume cursor and will be retried on the next call. */
  retrying: CopyFailure[];
  /** Cumulative over every slice of this copy. */
  totals: Counts;
  /** Files of this slice that had to stream (copyRequiresWriterPermission, no sharing rights). */
  streamedFiles: number;
  /** Google Docs/Sheets/Slides of this slice that streamed: exported and imported back. */
  converted: { path: string; note: string }[];
  /** Items of this slice left out on purpose, with the reason. */
  notCopied: { path: string; reason: string }[];
  notCopiedTotal: number;
  /** Temporary reader grants created and removed in this slice (cross-account). */
  temporaryGrants: { created: number; removed: number };
  /** Loud: temporary grants that could not be removed, each with the permission id and how to remove it. */
  warnings: string[];
  done: boolean;
  /** Pass back as `resume` to continue; absent when done. */
  resume?: string;
  note: string;
}

export interface CopyTreePlan {
  kind: "folder";
  dryRun: true;
  crossAccount: boolean;
  source: FileResult;
  destination: { account: string; path: string };
  files: number;
  folders: number;
  shortcuts: number;
  bytes: number;
  /** True when the walk stopped at DRY_RUN_WALK_CAP items. */
  truncated: boolean;
  /** Calls needed at maxFiles items per call (at least one). */
  calls: number;
  /** Cross-account: files copied server-side through a temporary per-file reader grant. */
  grantedFiles: number;
  /** Cross-account: files that will stream instead (they may not be shared for copying). */
  streamedFiles: number;
  /** Per-item predictions: streamed, converted or skipped, with the reason. */
  predictions: { name: string; issue: string }[];
  note: string;
}

export interface CopyTreeOpts {
  now?: () => number;
  budgetMs?: number;
  /** Injected for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const zero = (): Counts => ({ copiedFiles: 0, createdFolders: 0, shortcuts: 0, skipped: 0, failed: 0 });
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(s: string): Cursor {
  let c: Cursor;
  try {
    c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
  } catch {
    throw new Error("Invalid resume cursor: pass back the resume value returned by the previous copy call unchanged");
  }
  if (c?.v !== 1 || typeof c.topDest !== "string" || !Array.isArray(c.pending) || !c.totals) throw new Error("Invalid resume cursor (unknown format)");
  return c;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 404 (share not propagated yet), 429 and 5xx are worth another try; everything else is final. */
export function isTransient(e: unknown): boolean {
  return e instanceof DriveError && (e.status === 404 || e.status === 429 || e.status >= 500);
}

async function allChildren(c: Ctx, folderId: string): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await c.drive.listChildren(folderId, pageToken);
    out.push(...page.files);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** True when `folderId` is `ancestorId` or lies below it (same account; walks parents, 32 levels max). */
async function isWithin(c: Ctx, folderId: string, ancestorId: string): Promise<boolean> {
  let current = folderId;
  for (let i = 0; i < 32; i++) {
    if (current === ancestorId) return true;
    let f: DriveFile;
    try {
      f = await c.drive.getFile(current);
    } catch {
      return false;
    }
    const parent = f.parents?.[0];
    if (!parent) return false;
    current = parent;
  }
  return false;
}

/** A destination child counts as "already there" when the name matches and, for binary files, the size too. */
function sameItem(src: DriveFile, dest: DriveFile | undefined): boolean {
  if (!dest) return false;
  if (src.mimeType === FOLDER_MIME) return dest.mimeType === FOLDER_MIME;
  if (src.mimeType === SHORTCUT_MIME) return dest.mimeType === SHORTCUT_MIME;
  if (isGoogleNativeMime(src.mimeType)) return dest.mimeType === src.mimeType;
  return dest.mimeType !== FOLDER_MIME && (src.size === undefined || dest.size === undefined || src.size === dest.size);
}

// ---- dry run ---------------------------------------------------------------

export async function planCopyTree(a: CopyTreeArgs, src: Ctx, dst: Ctx, file: DriveFile, toFolderId: string, name: string): Promise<CopyTreePlan> {
  let files = 0;
  let folders = 0;
  let shortcuts = 0;
  let bytes = 0;
  let seen = 0;
  let truncated = false;
  let grantedFiles = 0;
  let streamedFiles = 0;
  const predictions: CopyTreePlan["predictions"] = [];
  const crossAccount = src !== dst;
  const predict = (name: string, issue: string) => {
    if (predictions.length < 200) predictions.push({ name, issue });
  };
  const queue = [file.id];
  while (queue.length && !truncated) {
    const id = queue.shift()!;
    let pageToken: string | undefined;
    do {
      const page = await src.drive.listChildren(id, pageToken);
      for (const f of page.files) {
        if (++seen > DRY_RUN_WALK_CAP) {
          truncated = true;
          break;
        }
        if (f.mimeType === FOLDER_MIME) {
          folders++;
          queue.push(f.id);
        } else if (f.mimeType === SHORTCUT_MIME) shortcuts++;
        else {
          files++;
          bytes += f.size ? Number(f.size) : 0;
          if (crossAccount) {
            const blocker = shareBlocker(f);
            if (!blocker) grantedFiles++;
            else {
              const no = unstreamable(f);
              if (no) predict(f.name, `will be skipped: ${no}`);
              else {
                streamedFiles++;
                predict(f.name, `will stream through this server (${blocker})${isGoogleNativeMime(f.mimeType) ? `; will be ${CONVERTED_NOTE}` : ""}`);
              }
            }
          }
        }
      }
      pageToken = truncated ? undefined : page.nextPageToken;
    } while (pageToken);
  }
  const maxFiles = a.maxFiles ?? DEFAULT_MAX_FILES;
  const destPath = `${await pathResolver.displayPath(dst.account.label, dst.drive, toFolderId, dst.rootId)}`.replace(/\/$/, "") + `/${name}`;
  return {
    kind: "folder",
    dryRun: true,
    crossAccount: src !== dst,
    source: await toResult(src, file),
    destination: { account: dst.account.label, path: destPath },
    files,
    folders,
    shortcuts,
    bytes,
    truncated,
    calls: Math.max(1, Math.ceil((files + folders + shortcuts) / maxFiles)),
    grantedFiles,
    streamedFiles,
    predictions,
    note:
      `Nothing was copied. Run again with dryRun=false; each call copies up to ${maxFiles} items and returns a resume cursor until done=true.` +
      (crossAccount
        ? ` Cross-account: no folder is shared; for each of ${grantedFiles} file(s) ${src.account.label} grants ${dst.account.label} temporary ${TEMP_GRANT_ROLE} access to that one file ` +
          `(expiring after ${TEMP_GRANT_TTL_MS / 3_600_000} h, removed right after the file is copied, audited)` +
          (streamedFiles ? `; ${streamedFiles} file(s) stream through this server instead (see predictions)` : "") +
          "."
        : "") +
      (truncated ? ` The walk stopped at ${DRY_RUN_WALK_CAP} items, so the totals are a lower bound.` : ""),
  };
}

// ---- cross-account helpers -------------------------------------------------

/** What one slice learns while copying files across accounts. */
interface SliceLog {
  meta: OpMeta;
  grants: { created: number; removed: number };
  warnings: string[];
  converted: CopyTreeResult["converted"];
  notCopied: CopyTreeResult["notCopied"];
  streamed: number;
  /** Time left in the slice, for a file that has to stream. */
  remainingMs: () => number;
}

/** files.copy as the destination, retrying 404 / 429 / 5xx with backoff (cross-account only). */
async function copyWithRetry(dst: Ctx, child: DriveFile, destId: string, retry: boolean, sleep: (ms: number) => Promise<void>): Promise<DriveFile> {
  const meta = { name: child.name, parents: [destId] };
  for (let attempt = 0; ; attempt++) {
    try {
      return await dst.drive.copy(child.id, meta);
    } catch (e) {
      if (!retry || !isTransient(e) || attempt >= COPY_RETRY_BACKOFF_MS.length) throw e;
      await sleep(COPY_RETRY_BACKOFF_MS[attempt]!);
    }
  }
}

/**
 * Copy one file into the destination folder. Same account: files.copy. Cross-account: a temporary reader grant on
 * this one file, files.copy as the destination, the grant removed in `finally`; or, for a file that may not be
 * shared for copying, a stream through this server. Returns undefined when the file was left out on purpose.
 */
async function copyOne(src: Ctx, dst: Ctx, child: DriveFile, destId: string, crossAccount: boolean, sleep: (ms: number) => Promise<void>, log: SliceLog): Promise<DriveFile | undefined> {
  if (!crossAccount) return copyWithRetry(dst, child, destId, false, sleep);
  const blocker = shareBlocker(child);
  if (blocker) {
    const no = unstreamable(child);
    if (no) {
      log.notCopied.push({ path: child.name, reason: no });
      return undefined;
    }
    const r = await streamById(
      { fromAccount: src.account.label, fileId: child.id, toAccount: dst.account.label, toFolderId: destId, reason: blocker, budgetMs: Math.max(1000, log.remainingMs()) },
      { actor: log.meta.actor },
    );
    if ("dryRun" in r) throw new Error("unexpected dry run");
    if (r.notCopied[0]) {
      log.notCopied.push({ path: child.name, reason: r.notCopied[0].reason });
      return undefined;
    }
    if (r.failed[0]) throw new Error(r.failed[0].error);
    if (!r.done) throw new Error(`did not finish streaming inside this slice; copy it on its own with the copy tool (it resumes), then run this copy again`);
    log.streamed++;
    if (r.converted.length) log.converted.push({ path: child.name, note: CONVERTED_NOTE });
    const id = r.created[0]?.id;
    return id ? dst.drive.getFile(id) : dst.drive.findChildByName(destId, child.name, false);
  }
  const g = await grantTemporaryRead(src, dst, child, { ...log.meta, tool: "copy" });
  if (g.kind === "existing") return copyWithRetry(dst, child, destId, true, sleep);
  log.grants.created++;
  try {
    return await copyWithRetry(dst, child, destId, true, sleep);
  } finally {
    const r = await removeTemporaryGrant(src, g.grant, log.meta);
    if (r.removed) log.grants.removed++;
    else if (r.warning) log.warnings.push(r.warning);
  }
}

/** Remove the writer share a pre-1.0.1 cursor left on the source top folder. */
async function removeLegacyShare(src: Ctx, dst: Ctx, file: DriveFile, cursor: Cursor, meta: OpMeta, log: SliceLog): Promise<void> {
  if (!cursor.share) return;
  const g: TempGrant = {
    account: src.account.label,
    toAccount: dst.account.label,
    email: dst.ownEmail,
    fileId: file.id,
    name: file.name,
    role: TEMP_GRANT_ROLE,
    permissionId: cursor.share.permissionId,
    createdAt: new Date().toISOString(),
    tool: "copy",
  };
  const r = await removeTemporaryGrant(src, g, meta);
  if (r.removed) log.grants.removed++;
  else if (r.warning) log.warnings.push(r.warning.replace(`${TEMP_GRANT_ROLE} access`, "writer access (a folder share left by an earlier version)"));
  delete cursor.share;
  delete cursor.visible;
}

// ---- copy ------------------------------------------------------------------

export async function copyTree(a: CopyTreeArgs, meta: OpMeta, opts: CopyTreeOpts = {}): Promise<CopyTreeResult | CopyTreePlan | StreamCopyResult | StreamCopyPlan> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = now() + (opts.budgetMs ?? SLICE_BUDGET_MS);
  const maxFiles = Math.max(1, a.maxFiles ?? DEFAULT_MAX_FILES);
  const src = await ctxFor(a.fromAccount);
  const dst = a.toAccount === a.fromAccount ? src : await ctxFor(a.toAccount);
  const crossAccount = src !== dst;
  const file = await src.drive.getFile(a.fileId);
  if (file.mimeType !== FOLDER_MIME) throw new Error(`${file.name} is not a folder`);
  if (a.trashOriginal) assertWritable(file, "edit");
  const name = a.newName ?? file.name;

  // A read-only source is never written to, not even a permission: the whole tree streams through this server.
  const streamResume = a.resume !== undefined && isStreamCursor(a.resume);
  if (crossAccount && (streamResume || (await isAccountReadOnly(src.account.label)))) {
    if (a.trashOriginal) throw new Error(`trashOriginal is refused: ${readOnlySourceReason(src.account.label)}`);
    if (a.resume && !streamResume) {
      throw new Error(`source account ${src.account.label} became read-only during this copy; start the copy again without resume (items already copied are skipped)`);
    }
    if (!a.toPath && !a.toFolderId && !a.resume) throw new Error("Give toPath or toFolderId for the destination folder");
    const toFolderId = await targetFolder(dst, a);
    if (!a.resume) assertWritable(await dst.drive.getFile(toFolderId), "addChildren");
    return streamCopy(
      { fromAccount: a.fromAccount, fileId: a.fileId, toAccount: a.toAccount, toFolderId, newName: a.newName, resume: a.resume, dryRun: a.dryRun, maxFiles: a.maxFiles, budgetMs: opts.budgetMs },
      readOnlySourceReason(src.account.label),
      meta,
    );
  }

  let cursor: Cursor | undefined;
  if (a.resume) {
    cursor = decodeCursor(a.resume);
    if (cursor.from !== a.fromAccount || cursor.fileId !== a.fileId || cursor.to !== a.toAccount) {
      throw new Error(`This resume cursor belongs to a different copy (${cursor.from}:${cursor.fileId} -> ${cursor.to}); pass the same fromAccount, fileId and toAccount`);
    }
  }

  let toFolderId: string;
  let top: DriveFile;
  let topCreated = false;
  if (cursor) {
    top = await dst.drive.getFile(cursor.topDest);
    toFolderId = top.parents?.[0] ?? (await targetFolder(dst, a));
  } else {
    if (!a.toPath && !a.toFolderId) throw new Error("Give toPath or toFolderId for the destination folder");
    toFolderId = await targetFolder(dst, a);
    const target = await dst.drive.getFile(toFolderId);
    assertWritable(target, "addChildren");
    if (!crossAccount && (await isWithin(dst, toFolderId, file.id))) {
      throw new Error(`Cannot copy ${file.name} inside itself (${toFolderId} is the folder or lies below it)`);
    }
    if (a.dryRun) return planCopyTree(a, src, dst, file, toFolderId, name);
    const existing = await dst.drive.findChildByName(toFolderId, name, true);
    if (existing) top = existing;
    else {
      top = await dst.drive.createFolder(name, toFolderId);
      topCreated = true;
    }
    cursor = { v: 1, from: a.fromAccount, fileId: a.fileId, to: a.toAccount, topDest: top.id, pending: [[file.id, top.id]], totals: zero() };
  }

  const log: SliceLog = { meta, grants: { created: 0, removed: 0 }, warnings: [], converted: [], notCopied: [], streamed: 0, remainingMs: () => deadline - now() };
  if (crossAccount) await removeLegacyShare(src, dst, file, cursor, meta, log);

  const slice: Counts = topCreated ? { ...zero(), createdFolders: 1 } : zero();
  const failures: CopyFailure[] = [];
  const retrying: CopyFailure[] = [];
  const retryNext: RetryItem[] = [];
  let processed = topCreated ? 1 : 0;
  const destListing = new Map<string, Map<string, DriveFile>>();
  const childrenOf = async (destId: string) => {
    let m = destListing.get(destId);
    if (!m) {
      m = new Map((await allChildren(dst, destId)).map((f) => [f.name, f]));
      destListing.set(destId, m);
    }
    return m;
  };
  const outOfBudget = () => processed >= maxFiles || now() > deadline;

  const copyChild = async (child: DriveFile, destId: string, existing: Map<string, DriveFile>, rounds: number) => {
    try {
      const copied = await copyOne(src, dst, child, destId, crossAccount, sleep, log);
      if (!copied) return;
      existing.set(child.name, copied);
      slice.copiedFiles++;
    } catch (e) {
      const failure = { id: child.id, name: child.name, error: errorMessage(e) };
      if (crossAccount && isTransient(e) && rounds < MAX_RETRY_ROUNDS) {
        retrying.push(failure);
        retryNext.push([child.id, destId, child.name, rounds + 1]);
      } else {
        slice.failed++;
        failures.push(failure);
      }
    }
  };

  // Items that failed transiently in an earlier slice come first.
  const retryQueue = cursor.retry ?? [];
  while (retryQueue.length && !outOfBudget()) {
    const [srcId, destId, itemName, rounds] = retryQueue.shift()!;
    const existing = await childrenOf(destId);
    processed++;
    let child: DriveFile;
    try {
      child = await src.drive.getFile(srcId);
    } catch (e) {
      slice.failed++;
      failures.push({ id: srcId, name: itemName, error: errorMessage(e) });
      continue;
    }
    if (sameItem(child, existing.get(child.name))) slice.skipped++;
    else await copyChild(child, destId, existing, rounds);
  }

  let stopped = false;
  while (cursor.pending.length && !retryQueue.length && !stopped) {
    const [srcId, destId, pageToken, offset = 0] = cursor.pending[0]!;
    const existing = await childrenOf(destId);
    const page = await src.drive.listChildren(srcId, pageToken);
    let i = offset;
    for (; i < page.files.length; i++) {
      if (outOfBudget()) {
        stopped = true;
        break;
      }
      const child = page.files[i]!;
      const dup = existing.get(child.name);
      // Only Drive writes count towards maxFiles; skipping an existing item is a read and must not stall a resume.
      try {
        if (child.mimeType === FOLDER_MIME) {
          let folder = sameItem(child, dup) ? dup! : undefined;
          if (!folder) {
            processed++;
            folder = await dst.drive.createFolder(child.name, destId);
            slice.createdFolders++;
            existing.set(child.name, folder);
          }
          cursor.pending.push([child.id, folder.id]);
        } else if (child.mimeType === SHORTCUT_MIME) {
          if (sameItem(child, dup)) slice.skipped++;
          else {
            processed++;
            const targetId = child.shortcutDetails?.targetId;
            if (!targetId) throw new Error("shortcut without a target");
            existing.set(child.name, await dst.drive.createShortcut(child.name, targetId, destId));
            slice.shortcuts++;
          }
        } else if (sameItem(child, dup)) slice.skipped++;
        else {
          processed++;
          await copyChild(child, destId, existing, 0);
        }
      } catch (e) {
        slice.failed++;
        failures.push({ id: child.id, name: child.name, error: errorMessage(e) });
      }
    }
    if (stopped) {
      // Resume inside this page (Drive's folder,name order is stable); the name check still catches anything already copied.
      cursor.pending[0] = [srcId, destId, pageToken, i];
    } else if (page.nextPageToken) cursor.pending[0] = [srcId, destId, page.nextPageToken];
    else cursor.pending.shift();
  }

  const retry = [...retryQueue, ...retryNext];
  cursor.retry = retry.length ? retry : undefined;
  for (const k of Object.keys(slice) as (keyof Counts)[]) cursor.totals[k] += slice[k];
  cursor.notCopiedTotal = (cursor.notCopiedTotal ?? 0) + log.notCopied.length;
  const done = cursor.pending.length === 0 && retry.length === 0;

  const auditEntry: Omit<AuditEntry, "ts"> = {
    tool: "copy",
    account: a.fromAccount,
    toAccount: a.toAccount,
    fileId: top.id,
    name: top.name,
    from: file.id,
    to: toFolderId,
    owner: ownerLabel(src, file),
    actor: meta.actor,
    batchId: meta.batchId,
    counts: { ...slice },
    done,
  };
  await appendAudit(auditEntry);

  let trashed = false;
  if (done && a.trashOriginal && (cursor.notCopiedTotal ?? 0) > 0) {
    log.warnings.push(`The source was not trashed: ${cursor.notCopiedTotal} item(s) were not copied.`);
  } else if (done && a.trashOriginal) {
    await src.drive.setTrashed(file.id, true);
    trashed = true;
    await appendAudit({ tool: "trash", account: a.fromAccount, fileId: file.id, name: file.name, owner: ownerLabel(src, file), actor: meta.actor, batchId: meta.batchId });
  }

  const noteParts = [
    done
      ? `Done: ${cursor.totals.copiedFiles} files, ${cursor.totals.shortcuts} shortcuts and ${cursor.totals.createdFolders} folders in total; ${cursor.totals.skipped} already existed.`
      : `Not finished: call copy again with the same arguments plus this resume cursor.`,
    retrying.length ? `${retrying.length} item(s) answered a transient error and will be retried on the next call.` : "",
    crossAccount
      ? `Cross-account: ${log.grants.created} temporary ${TEMP_GRANT_ROLE} grant(s) for ${dst.ownEmail}, one file at a time, ${log.grants.removed} removed; no folder was shared.`
      : "",
    log.streamed ? `${log.streamed} file(s) could not be shared for copying and were streamed through this server.` : "",
    log.converted.length ? `${log.converted.length} Google Docs/Sheets/Slides ${CONVERTED_NOTE}.` : "",
    log.notCopied.length ? `${log.notCopied.length} item(s) were not copied (see notCopied).` : "",
    failures.length ? `${failures.length} item(s) failed permanently and were left out; see failures.` : "",
    ...log.warnings,
  ].filter(Boolean);

  return {
    kind: "folder",
    crossAccount,
    source: { ...(await toResult(src, file)), trashed },
    top: await toResult(dst, top),
    topCreated,
    ...slice,
    failures,
    retrying,
    totals: cursor.totals,
    streamedFiles: log.streamed,
    converted: log.converted,
    notCopied: log.notCopied,
    notCopiedTotal: cursor.notCopiedTotal ?? 0,
    temporaryGrants: log.grants,
    warnings: log.warnings,
    done,
    resume: done ? undefined : encodeCursor(cursor),
    note: noteParts.join(" "),
  };
}
