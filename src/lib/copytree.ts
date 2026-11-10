/**
 * Recursive folder copy behind the `copy` tool (files still go through
 * ops.ts `copyFile`). The tree is copied breadth-first in slices of at most
 * `maxFiles` items per call so a Vercel function never has to finish a big
 * tree in one go: each call returns an opaque `resume` cursor (base64 JSON
 * with the pending [source, destination] folder pairs, items waiting for a
 * retry and the temporary share) that the client passes back to continue.
 *
 * Cross-account: the source account shares the top folder with the
 * destination account once (writer, no e-mail); Drive inherits that
 * permission to everything below, the destination account copies
 * server-side, and the share is removed when the copy is done. No bytes pass
 * through this server. Same account: the same walker without the share.
 *
 * Drive propagates an inherited share asynchronously, so the destination can
 * answer 404 for children for a few seconds. After sharing we wait until the
 * first child is visible (backoff up to ~15 s); a 404 / 5xx on one file is
 * retried with backoff, then the file is shared individually as a fallback;
 * what still fails goes back into the cursor (done stays false) for up to
 * MAX_RETRY_ROUNDS resumes before it is reported as a permanent failure.
 *
 * Idempotent: a destination child with the same name (and, for binary
 * files, the same size) is skipped, so a slice that was cut short or a
 * repeated call never duplicates anything.
 */
import { appendAudit, type AuditEntry } from "./audit";
import { assertWritable, ctxFor, ownerLabel, targetFolder, toResult, type Ctx, type FileResult } from "./ctx";
import { DriveError, FOLDER_MIME, SHORTCUT_MIME, type DriveFile } from "./drive";
import { isGoogleNativeMime } from "./naming";
import type { OpMeta } from "./ops";
import { pathResolver } from "./paths";

export const DEFAULT_MAX_FILES = 150;
export const DRY_RUN_WALK_CAP = 5000;
/** Stop a slice after this long so the function returns a cursor before Vercel's limit (maxDuration 300 s). */
export const SLICE_BUDGET_MS = 240_000;
/** Backoff (ms) while waiting for a fresh share to reach the children: ~15 s in total. */
export const VISIBILITY_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
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
  /** Temporary writer permission on the source top folder (cross-account only). */
  share?: { permissionId: string };
  /** True once the destination account could see a child of the shared folder. */
  visible?: boolean;
  totals: Counts;
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
    note:
      `Nothing was copied. Run again with dryRun=false; each call copies up to ${maxFiles} items and returns a resume cursor until done=true.` +
      (truncated ? ` The walk stopped at ${DRY_RUN_WALK_CAP} items, so the totals are a lower bound.` : ""),
  };
}

// ---- cross-account helpers -------------------------------------------------

/** Wait (backoff, ~15 s) until the destination account can read the first child of the shared folder. */
async function waitForVisibility(src: Ctx, dst: Ctx, folderId: string, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  const first = (await src.drive.listChildren(folderId)).files[0];
  if (!first) return true;
  for (let i = 0; ; i++) {
    try {
      await dst.drive.getFile(first.id);
      return true;
    } catch (e) {
      if (!isTransient(e) || i >= VISIBILITY_BACKOFF_MS.length) return false;
      await sleep(VISIBILITY_BACKOFF_MS[i]!);
    }
  }
}

/**
 * Copy one file into the destination. Cross-account: retry transient errors
 * with backoff, then share this one file directly (writer, no e-mail), copy
 * and remove that share again. Throws the last error when nothing worked.
 */
async function copyOne(src: Ctx, dst: Ctx, child: DriveFile, destId: string, crossAccount: boolean, sleep: (ms: number) => Promise<void>): Promise<DriveFile> {
  const meta = { name: child.name, parents: [destId] };
  for (let attempt = 0; attempt <= (crossAccount ? COPY_RETRY_BACKOFF_MS.length : 0); attempt++) {
    try {
      return await dst.drive.copy(child.id, meta);
    } catch (e) {
      if (!crossAccount || !isTransient(e)) throw e;
      if (attempt < COPY_RETRY_BACKOFF_MS.length) await sleep(COPY_RETRY_BACKOFF_MS[attempt]!);
    }
  }
  // Fallback: an explicit permission on the file itself is visible immediately.
  const perm = await src.drive.createPermission(child.id, { type: "user", role: "writer", emailAddress: dst.ownEmail }, { sendNotificationEmail: false });
  try {
    return await dst.drive.copy(child.id, meta);
  } finally {
    await src.drive.removePermission(child.id, perm.id).catch(() => undefined);
  }
}

// ---- copy ------------------------------------------------------------------

export async function copyTree(a: CopyTreeArgs, meta: OpMeta, opts: CopyTreeOpts = {}): Promise<CopyTreeResult | CopyTreePlan> {
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

  // One temporary writer share on the top source folder; Drive inherits it to the whole tree (asynchronously).
  if (crossAccount && !cursor.share) {
    const existingPerm = (await src.drive.listPermissions(file.id)).find((p) => p.emailAddress?.toLowerCase() === dst.ownEmail);
    if (!existingPerm) {
      const perm = await src.drive.createPermission(file.id, { type: "user", role: "writer", emailAddress: dst.ownEmail }, { sendNotificationEmail: false });
      cursor.share = { permissionId: perm.id };
      await appendAudit({ tool: "share", account: a.fromAccount, fileId: file.id, name: file.name, email: dst.ownEmail, role: "writer", owner: ownerLabel(src, file), actor: meta.actor, batchId: meta.batchId, note: "temporary, for a folder copy" });
    }
  }
  if (crossAccount && !cursor.visible) cursor.visible = await waitForVisibility(src, dst, file.id, sleep);

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
      existing.set(child.name, await copyOne(src, dst, child, destId, crossAccount, sleep));
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

  if (done && cursor.share) {
    await src.drive.removePermission(file.id, cursor.share.permissionId).catch(() => undefined);
    await appendAudit({ tool: "unshare", account: a.fromAccount, fileId: file.id, name: file.name, email: dst.ownEmail, owner: ownerLabel(src, file), actor: meta.actor, batchId: meta.batchId, note: "temporary share for a folder copy removed" });
    delete cursor.share;
  }

  let trashed = false;
  if (done && a.trashOriginal) {
    await src.drive.setTrashed(file.id, true);
    trashed = true;
    await appendAudit({ tool: "trash", account: a.fromAccount, fileId: file.id, name: file.name, owner: ownerLabel(src, file), actor: meta.actor, batchId: meta.batchId });
  }

  const noteParts = [
    done
      ? `Done: ${cursor.totals.copiedFiles} files, ${cursor.totals.shortcuts} shortcuts and ${cursor.totals.createdFolders} folders in total; ${cursor.totals.skipped} already existed.`
      : `Not finished: call copy again with the same arguments plus this resume cursor.`,
    retrying.length ? `${retrying.length} item(s) answered a transient error (the share may not have propagated yet) and will be retried on the next call.` : "",
    crossAccount ? (done ? `The temporary writer share for ${dst.ownEmail} on the source folder was removed.` : `The source folder stays shared with ${dst.ownEmail} (writer) until the copy is done.`) : "",
    failures.length ? `${failures.length} item(s) failed permanently and were left out; see failures.` : "",
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
    done,
    resume: done ? undefined : encodeCursor(cursor),
    note: noteParts.join(" "),
  };
}
