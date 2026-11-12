/**
 * Cross-account, cross-provider copy / move of a file or a folder tree, in
 * resumable slices (same idea as copytree.ts): each call works until
 * `maxFiles` items or the time budget are used up and returns an opaque
 * `cursor`; the caller repeats with it until `done`.
 *
 * Bytes stream source → destination one chunk at a time (the destination's
 * chunk size, ≈8 MB); nothing is buffered whole except Google exports
 * (Drive caps those at 10 MB). A file that does not finish inside a slice
 * keeps its upload session in the cursor and continues with a ranged
 * download on the next call.
 *
 * Verification, per file: the destination's size must equal the bytes sent;
 * the bytes are hashed on the way through in the source's and the
 * destination's own hash kinds and compared with what each side reports
 * (md5 for Drive, quickXorHash for OneDrive, content_hash for Dropbox). A
 * mismatch trashes the fresh destination copy and reports the file as failed.
 *
 * Idempotent: an existing destination item with the same (destination) name
 * is skipped when size and every comparable hash match; otherwise it is a
 * conflict, reported and never overwritten. Folders are merged.
 *
 * Move = copy + verify, then the SOURCE top item is trashed (recoverable:
 * Drive trash, OneDrive recycle bin, Dropbox deleted files), only on the
 * final slice and only when no item of the whole transfer failed or was left
 * behind. Google → Google is delegated to the existing server-side copy
 * (copytree.ts / ops.ts), so no bytes pass through this server.
 */
import { appendAudit } from "../audit";
import { copyTree, type CopyTreePlan, type CopyTreeResult } from "../copytree";
import { copyFile } from "../ops";
import type { Account } from "../store";
import { hashesMatch, MultiHasher } from "./hash";
import { assertWriteMode, parseRef, providerFor, PROVIDER_NAMES } from "./index";
import { exportFor, exportedName } from "./google";
import { limitProblem, targetName } from "./names";
import { joinPath, ProviderError, type Entry, type Hashes, type HashKind, type StorageProvider, type UploadHandle } from "./types";

export const TRANSFER_BUDGET_MS = 240_000;
export const DEFAULT_TRANSFER_MAX_FILES = 200;
export const DRY_RUN_CAP = 5000;
export const MAX_REPORTED = 200;

export interface TransferArgs {
  /** `label:/path` of the file or folder to transfer. */
  from: string;
  /** `label:/path` of the destination folder (must exist). The item keeps its name inside it. */
  to: string;
  move?: boolean;
  cursor?: string;
  budgetMs?: number;
  dryRun?: boolean;
  maxFiles?: number;
}

export interface TransferOpts {
  actor: string;
  now?: () => number;
}

export interface Failure {
  path: string;
  error: string;
}

export interface Totals {
  copied: number;
  folders: number;
  skipped: number;
  failed: number;
  bytes: number;
  verifiedHash: number;
  verifiedSize: number;
}

interface EntryLite {
  id: string;
  path: string;
  name: string;
  isFolder: boolean;
}

/** [source folder, destination folder, page token of the page in progress, items of that page already handled]. */
type QueueItem = [EntryLite, EntryLite, string | null, number];

interface PartialFile {
  src: Entry;
  dest: EntryLite;
  handle: UploadHandle;
  offset: number;
}

interface CrossCursor {
  v: 1;
  kind: "cross";
  from: string;
  to: string;
  move: boolean;
  srcTop: Entry;
  queue: QueueItem[];
  partial?: PartialFile;
  totals: Totals;
  /** First MAX_REPORTED failures of the whole transfer (all slices). */
  failures: Failure[];
}

interface GoogleCursor {
  v: 1;
  kind: "google";
  from: string;
  to: string;
  move: boolean;
  resume: string;
}

type Cursor = CrossCursor | GoogleCursor;

export interface TransferResult {
  done: boolean;
  /** Pass back as `cursor` to continue; absent when done. */
  cursor?: string;
  from: string;
  to: string;
  route: string;
  /** This slice. */
  copied: number;
  skipped: number;
  folders: number;
  bytes: number;
  failed: Failure[];
  verified: { hash: number; size: number };
  /** Whole transfer so far. */
  totals: Totals;
  /** Conversions, renames and warnings seen in this slice. */
  notes: string[];
  move?: { trashed: boolean; reason?: string };
  report: string;
}

export interface TransferPlan {
  dryRun: true;
  from: string;
  to: string;
  route: string;
  files: number;
  folders: number;
  bytes: number;
  /** Google-native files that will be exported (their size is not known before export). */
  exports: number;
  /** Things that will not transfer cleanly: conversions, renames, size/path limits, unsupported items, existing items. */
  issues: { path: string; issue: string }[];
  truncated: boolean;
  estimatedSlices: number;
  note: string;
}

const zero = (): Totals => ({ copied: 0, folders: 0, skipped: 0, failed: 0, bytes: 0, verifiedHash: 0, verifiedSize: 0 });

export function encodeTransferCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeTransferCursor(s: string): Cursor {
  let c: Cursor;
  try {
    c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
  } catch {
    throw new Error("Invalid transfer cursor: pass back the cursor returned by the previous call unchanged");
  }
  if (c?.v !== 1 || (c.kind !== "cross" && c.kind !== "google")) throw new Error("Invalid transfer cursor (unknown format)");
  return c;
}

const lite = (e: Entry): EntryLite => ({ id: e.id, path: e.path, name: e.name, isFolder: e.isFolder });
const asEntry = (e: EntryLite): Entry => ({ ...e });
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Re-cut an async byte stream into pieces of exactly `size` bytes (the last one shorter). */
export async function* rechunk(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let parts: Uint8Array[] = [];
  let len = 0;
  const concat = () => (parts.length === 1 ? parts[0]! : new Uint8Array(Buffer.concat(parts, len)));
  for await (const piece of source) {
    if (!piece.length) continue;
    parts.push(piece);
    len += piece.length;
    while (len >= size) {
      const all = concat();
      yield all.subarray(0, size);
      const rest = all.subarray(size);
      parts = rest.length ? [rest] : [];
      len = rest.length;
    }
  }
  if (len > 0) yield concat();
}

// ---- the per-file step --------------------------------------------------------

type FileOutcome =
  | { kind: "copied"; bytes: number; verified: "hash" | "size"; note?: string }
  | { kind: "skipped"; verified: "hash" | "size" }
  | { kind: "failed"; error: string }
  | { kind: "partial"; partial: PartialFile; bytes: number };

interface Slice {
  src: StorageProvider;
  dst: StorageProvider;
  deadline: number;
  now: () => number;
  notes: string[];
  actor: string;
}

function note(s: Slice, line: string) {
  if (s.notes.length < MAX_REPORTED) s.notes.push(line);
}

/** Name, export and limit checks shared by the dry run and the copy. */
function plannedName(s: Pick<Slice, "dst">, src: Entry, destFolderPath: string): { name: string; problem?: string; notes: string[] } {
  const notes: string[] = [];
  if (src.shortcut) return { name: src.name, problem: "Google Drive shortcut: not transferred", notes };
  let base = src.name;
  if (src.googleNative) {
    const x = exportFor(src);
    if (!x) return { name: src.name, problem: `Google-native type ${src.mimeType} cannot be exported`, notes };
    base = exportedName(src);
    notes.push(`exported as ${x.ext}: "${src.name}" -> "${base}"`);
  }
  const tn = targetName(s.dst.kind, base);
  if (tn.renamed) notes.push(`renamed "${base}" -> "${tn.name}" (${tn.renamed})`);
  if (tn.warning) notes.push(`"${tn.name}": ${tn.warning}`);
  const problem = limitProblem(s.dst.caps, tn.name, joinPath(destFolderPath, tn.name), src.googleNative ? undefined : src.size);
  return { name: tn.name, problem, notes };
}

/** Compare an existing destination file with the source; same → skip, different → conflict. */
function compareExisting(src: Entry, existing: Entry, srcSize: number | undefined): FileOutcome {
  if (existing.isFolder) return { kind: "failed", error: `a folder named "${existing.name}" already exists at the destination; not overwritten` };
  if (srcSize !== undefined && existing.size !== undefined && srcSize !== existing.size) {
    return { kind: "failed", error: `"${existing.name}" already exists at the destination with a different size (${existing.size} vs ${srcSize} bytes); not overwritten` };
  }
  const h = hashesMatch(src.hash, existing.hash);
  if (h === false) return { kind: "failed", error: `"${existing.name}" already exists at the destination with different content (hash differs); not overwritten` };
  if (srcSize === undefined || existing.size === undefined) {
    return { kind: "failed", error: `"${existing.name}" already exists at the destination and its size cannot be compared; not overwritten` };
  }
  return { kind: "skipped", verified: h ? "hash" : "size" };
}

function verify(src: Entry, final: Entry, size: number, digest: Hashes | undefined): { ok: true; level: "hash" | "size" } | { ok: false; error: string } {
  if (final.size !== undefined && final.size !== size) return { ok: false, error: `destination reports ${final.size} bytes, sent ${size}` };
  let level: "hash" | "size" = "size";
  if (digest) {
    const readOk = hashesMatch(digest, src.hash);
    if (readOk === false) return { ok: false, error: "bytes read do not match the source's hash" };
    const writeOk = hashesMatch(digest, final.hash);
    if (writeOk === false) return { ok: false, error: "destination hash does not match the bytes sent" };
    if (writeOk || readOk) level = "hash";
  } else {
    const direct = hashesMatch(src.hash, final.hash);
    if (direct === false) return { ok: false, error: "destination hash does not match the source hash" };
    if (direct) level = "hash";
  }
  return { ok: true, level };
}

async function streamFile(s: Slice, src: Entry, dest: EntryLite, name: string, resume?: PartialFile): Promise<FileOutcome> {
  const offset0 = resume?.offset ?? 0;
  const dl = await s.src.download(src, offset0);
  const total = resume ? resume.handle.size : (dl.size ?? src.size);
  if (total === undefined) return { kind: "failed", error: "source did not report a size" };
  if (!resume) {
    const problem = limitProblem(s.dst.caps, name, joinPath(dest.path, name), total);
    if (problem) return { kind: "failed", error: problem };
  }
  const handle = resume?.handle ?? (await s.dst.beginUpload(asEntry(dest), name, total, dl.contentType));
  // Hash on the way through only when the whole file passes through this slice.
  const kinds: HashKind[] = [...new Set<HashKind>([...(Object.keys(src.hash ?? {}) as HashKind[]), s.dst.caps.hashes[0]!])];
  const hasher = resume ? undefined : new MultiHasher(kinds);
  const resumable = s.src.caps.rangeDownload && !dl.exportedAs;
  let offset = offset0;
  let done: Entry | undefined;
  if (total === 0) {
    done = await s.dst.putChunk(handle, 0, new Uint8Array(0), true);
  } else {
    for await (const chunk of rechunk(dl.stream, s.dst.caps.chunkBytes)) {
      if (offset + chunk.length > total) throw new ProviderError(`source sent more than the announced ${total} bytes`, 500);
      const last = offset + chunk.length === total;
      hasher?.update(chunk);
      done = await s.dst.putChunk(handle, offset, chunk, last);
      offset += chunk.length;
      if (last) break;
      if (resumable && s.now() >= s.deadline) {
        return { kind: "partial", partial: { src, dest, handle, offset }, bytes: offset - offset0 };
      }
    }
    if (offset !== total) throw new ProviderError(`source ended after ${offset} of ${total} bytes`, 500);
  }
  const final = await s.dst.finishUpload(handle, done);
  const v = verify(src, final, total, hasher?.digest());
  if (!v.ok) {
    await s.dst.trash(final).catch(() => undefined);
    await appendAudit({ tool: "trash", account: s.dst.label, fileId: final.id, name: final.name, actor: s.actor, note: "transfer: copy failed verification" });
    return { kind: "failed", error: `verification failed (${v.error}); the destination copy was moved to trash` };
  }
  return { kind: "copied", bytes: total - offset0, verified: v.level };
}

async function transferOne(s: Slice, src: Entry, dest: EntryLite): Promise<FileOutcome> {
  const planned = plannedName(s, src, dest.path);
  for (const n of planned.notes) note(s, `${src.path}: ${n}`);
  if (planned.problem) return { kind: "failed", error: planned.problem };
  const existing = await s.dst.child(asEntry(dest), planned.name);
  if (existing) {
    if (!src.googleNative) return compareExisting(src, existing, src.size);
    // Exports have no size up front: export again and compare sizes.
    const dl = await s.src.download(src);
    let size = 0;
    for await (const c of dl.stream) size += c.length;
    return compareExisting({ ...src, hash: undefined }, existing, size);
  }
  return streamFile(s, src, dest, planned.name);
}

// ---- entry point -----------------------------------------------------------------

function route(src: StorageProvider, dst: StorageProvider): string {
  return `${PROVIDER_NAMES[src.kind]} (${src.label}) -> ${PROVIDER_NAMES[dst.kind]} (${dst.label})`;
}

export async function transfer(a: TransferArgs, opts: TransferOpts): Promise<TransferResult | TransferPlan> {
  const now = opts.now ?? Date.now;
  const deadline = now() + Math.min(a.budgetMs ?? TRANSFER_BUDGET_MS, TRANSFER_BUDGET_MS);
  const maxFiles = Math.max(1, a.maxFiles ?? DEFAULT_TRANSFER_MAX_FILES);
  const move = a.move ?? false;
  const fromRef = parseRef(a.from);
  const toRef = parseRef(a.to);
  const { account: srcAccount, provider: src } = await providerFor(fromRef.label);
  const { account: dstAccount, provider: dst } = await providerFor(toRef.label);

  let cursor: Cursor | undefined;
  if (a.cursor) {
    cursor = decodeTransferCursor(a.cursor);
    if (cursor.from !== a.from || cursor.to !== a.to || cursor.move !== move) {
      throw new Error(`This cursor belongs to a different transfer (${cursor.from} -> ${cursor.to}, move=${cursor.move}); pass the same from, to and move`);
    }
  }
  // The same gate for a dry run as for the real run, so a preview never promises a transfer that will be refused.
  // move=true trashes the source, which is a write on the source account too.
  await assertWriteMode(dstAccount);
  if (move) await assertWriteMode(srcAccount);

  if (src.kind === "google" && dst.kind === "google") {
    return googleToGoogle(a, { srcAccount, dstAccount, src, dst, move, maxFiles, cursor: cursor as GoogleCursor | undefined }, opts);
  }

  const s: Slice = { src, dst, deadline, now, notes: [], actor: opts.actor };
  let c: CrossCursor;
  if (cursor) {
    if (cursor.kind !== "cross") throw new Error("This cursor belongs to a Google-to-Google transfer");
    c = cursor;
  } else {
    const srcTop = await src.stat(fromRef.path);
    if (srcTop.path === "/") throw new Error("Transfer a folder or file, not the whole drive root");
    const destParent = await dst.stat(toRef.path);
    if (!destParent.isFolder) throw new Error(`${a.to} is not a folder`);
    if (fromRef.label === toRef.label && srcTop.isFolder && (destParent.path === srcTop.path || destParent.path.startsWith(`${srcTop.path}/`))) {
      throw new Error(`Cannot transfer ${a.from} into itself`);
    }
    if (a.dryRun) return planTransfer(s, a, srcTop, destParent);
    c = { v: 1, kind: "cross", from: a.from, to: a.to, move, srcTop, queue: [], totals: zero(), failures: [] };
    if (srcTop.isFolder) {
      const planned = plannedName(s, srcTop, destParent.path);
      for (const n of planned.notes) note(s, `${srcTop.path}: ${n}`);
      if (planned.problem) throw new Error(`${srcTop.path}: ${planned.problem}`);
      const existing = await dst.child(destParent, planned.name);
      if (existing && !existing.isFolder) throw new Error(`A file named "${planned.name}" already exists in ${a.to}; not overwritten`);
      const top = existing ?? (await dst.mkdir(destParent, planned.name));
      if (!existing) c.totals.folders++;
      c.queue.push([lite(srcTop), lite(top), null, 0]);
    } else {
      c.queue.push([lite(destParent), lite(destParent), "__single__", 0]);
    }
  }
  if (a.dryRun) throw new Error("dryRun cannot be combined with cursor");

  const slice = zero();
  const sliceFailures: Failure[] = [];
  const record = (path: string, o: FileOutcome) => {
    if (o.kind === "copied") {
      slice.copied++;
      slice.bytes += o.bytes;
      if (o.verified === "hash") slice.verifiedHash++;
      else slice.verifiedSize++;
    } else if (o.kind === "skipped") {
      slice.skipped++;
      if (o.verified === "hash") slice.verifiedHash++;
      else slice.verifiedSize++;
    } else if (o.kind === "failed") {
      slice.failed++;
      sliceFailures.push({ path, error: o.error });
    } else {
      slice.bytes += o.bytes;
    }
  };
  const runFile = async (srcEntry: Entry, dest: EntryLite, resume?: PartialFile): Promise<boolean> => {
    let o: FileOutcome;
    try {
      o = resume ? await streamFile(s, srcEntry, dest, resume.handle.name, resume) : await transferOne(s, srcEntry, dest);
    } catch (e) {
      o = { kind: "failed", error: msg(e) };
    }
    record(srcEntry.path, o);
    if (o.kind === "partial") {
      c.partial = o.partial;
      return false;
    }
    return true;
  };

  let handled = 0;
  let stop = false;
  if (c.partial) {
    const p = c.partial;
    c.partial = undefined;
    stop = !(await runFile(p.src, p.dest, p));
    handled++;
  }
  while (!stop && c.queue.length > 0) {
    if (handled >= maxFiles || now() >= deadline) break;
    const item = c.queue[0]!;
    const [srcFolder, destFolder, token, offset] = item;
    if (token === "__single__") {
      // A single-file transfer: the queue item only carries the destination folder.
      c.queue.shift();
      stop = !(await runFile(c.srcTop, destFolder));
      handled++;
      break;
    }
    let page;
    try {
      page = await src.list(asEntry(srcFolder), token ?? undefined);
    } catch (e) {
      record(srcFolder.path, { kind: "failed", error: `could not list folder: ${msg(e)}` });
      c.queue.shift();
      continue;
    }
    let i = offset;
    for (; i < page.entries.length; i++) {
      if (stop || handled >= maxFiles || now() >= deadline) break;
      const e = page.entries[i]!;
      handled++;
      if (e.isFolder) {
        try {
          const planned = plannedName(s, e, destFolder.path);
          for (const n of planned.notes) note(s, `${e.path}: ${n}`);
          if (planned.problem) throw new Error(planned.problem);
          const existing = await dst.child(asEntry(destFolder), planned.name);
          if (existing && !existing.isFolder) throw new Error(`a file named "${planned.name}" already exists at the destination; folder not merged`);
          const made = existing ?? (await dst.mkdir(asEntry(destFolder), planned.name));
          if (!existing) slice.folders++;
          c.queue.push([lite(e), lite(made), null, 0]);
        } catch (err) {
          record(e.path, { kind: "failed", error: msg(err) });
        }
      } else if (!(await runFile(e, destFolder))) {
        stop = true;
        i++;
        break;
      }
    }
    if (i < page.entries.length) {
      item[3] = i;
      break;
    }
    if (page.nextPageToken) {
      item[2] = page.nextPageToken;
      item[3] = 0;
    } else {
      c.queue.shift();
    }
  }

  // Fold this slice into the totals.
  for (const k of Object.keys(slice) as (keyof Totals)[]) c.totals[k] += slice[k];
  for (const f of sliceFailures) if (c.failures.length < MAX_REPORTED) c.failures.push(f);
  const done = c.queue.length === 0 && !c.partial;

  let moveInfo: TransferResult["move"];
  if (move && done) {
    if (c.totals.failed > 0) {
      moveInfo = { trashed: false, reason: `${c.totals.failed} item(s) failed or were not transferred; nothing was trashed. Fix them and run the transfer again (completed items are skipped).` };
    } else {
      await src.trash(c.srcTop);
      await appendAudit({ tool: "trash", account: src.label, fileId: c.srcTop.id, name: c.srcTop.name, actor: opts.actor, note: `transfer move: source trashed after every item verified at ${a.to}` });
      moveInfo = { trashed: true };
    }
  } else if (move) {
    moveInfo = { trashed: false, reason: "the source is trashed only on the final slice, after everything verified" };
  }

  await appendAudit({
    tool: "transfer",
    account: src.label,
    toAccount: dst.label,
    fileId: c.srcTop.id,
    name: c.srcTop.name,
    from: a.from,
    to: a.to,
    actor: opts.actor,
    counts: { copiedFiles: slice.copied, createdFolders: slice.folders, shortcuts: 0, skipped: slice.skipped, failed: slice.failed },
    done,
    size: slice.bytes,
    note: `${move ? "move" : "copy"} ${src.kind}->${dst.kind}`,
  });

  const t = c.totals;
  const report =
    `${done ? "Done" : "Partial (call again with cursor)"}: ${t.copied} copied, ${t.skipped} already present, ${t.folders} folders created, ${t.failed} failed; ` +
    `${t.bytes} bytes; verified by hash ${t.verifiedHash}, by size only ${t.verifiedSize}.` +
    (moveInfo ? (moveInfo.trashed ? " Source moved to trash." : ` Source not trashed: ${moveInfo.reason}`) : "");
  return {
    done,
    cursor: done ? undefined : encodeTransferCursor(c),
    from: a.from,
    to: a.to,
    route: route(src, dst),
    copied: slice.copied,
    skipped: slice.skipped,
    folders: slice.folders,
    bytes: slice.bytes,
    failed: done ? c.failures : sliceFailures,
    verified: { hash: slice.verifiedHash, size: slice.verifiedSize },
    totals: t,
    notes: s.notes,
    move: moveInfo,
    report,
  };
}

// ---- dry run ------------------------------------------------------------------------

async function planTransfer(s: Slice, a: TransferArgs, srcTop: Entry, destParent: Entry): Promise<TransferPlan> {
  const issues: TransferPlan["issues"] = [];
  const issue = (path: string, text: string) => {
    if (issues.length < MAX_REPORTED) issues.push({ path, issue: text });
  };
  let files = 0;
  let folders = 0;
  let bytes = 0;
  let exports = 0;
  let truncated = false;
  const visit = (e: Entry, destPath: string): string => {
    const p = plannedName(s, e, destPath);
    for (const n of p.notes) issue(e.path, n);
    if (p.problem) issue(e.path, `will fail: ${p.problem}`);
    if (e.isFolder) folders++;
    else {
      files++;
      if (e.googleNative) exports++;
      else bytes += e.size ?? 0;
    }
    return joinPath(destPath, p.name);
  };
  const topDest = visit(srcTop, destParent.path);
  const existing = await s.dst.child(destParent, plannedName(s, srcTop, destParent.path).name);
  if (existing) {
    issue(
      srcTop.path,
      existing.isFolder && srcTop.isFolder
        ? "destination folder already exists: contents are merged, identical files skipped, differing files reported as conflicts"
        : "an item with this name already exists at the destination: skipped if identical, otherwise reported as a conflict (never overwritten)",
    );
  }
  if (srcTop.isFolder) {
    const queue: [Entry, string][] = [[srcTop, topDest]];
    outer: while (queue.length) {
      const [folder, destPath] = queue.shift()!;
      let token: string | undefined;
      do {
        if (files + folders >= DRY_RUN_CAP || s.now() >= s.deadline) {
          truncated = true;
          break outer;
        }
        const page = await s.src.list(folder, token);
        for (const e of page.entries) {
          const d = visit(e, destPath);
          if (e.isFolder) queue.push([e, d]);
        }
        token = page.nextPageToken;
      } while (token);
    }
  }
  const items = files + folders;
  const r = route(s.src, s.dst);
  return {
    dryRun: true,
    from: a.from,
    to: a.to,
    route: r,
    files,
    folders,
    bytes,
    exports,
    issues,
    truncated,
    estimatedSlices: Math.max(1, Math.ceil(items / DEFAULT_TRANSFER_MAX_FILES), Math.ceil(bytes / (8 * 1024 * 1024 * 20))),
    note:
      `Nothing was written. ${files} file(s), ${folders} folder(s), ${bytes} bytes${exports ? ` plus ${exports} Google-native file(s) to export` : ""}` +
      `${truncated ? " (walk stopped early; totals are partial)" : ""}. Bytes pass through this server (${r}). ` +
      `Run again with dryRun=false, then repeat with the returned cursor until done=true.${a.move ? " move=true trashes the source only after every item verified." : ""}`,
  };
}

// ---- Google -> Google: server-side copy ------------------------------------------------

interface G2G {
  srcAccount: Account;
  dstAccount: Account;
  src: StorageProvider;
  dst: StorageProvider;
  move: boolean;
  maxFiles: number;
  cursor?: GoogleCursor;
}

async function googleToGoogle(a: TransferArgs, g: G2G, opts: TransferOpts): Promise<TransferResult | TransferPlan> {
  if (g.cursor && g.cursor.kind !== "google") throw new Error("This cursor belongs to a cross-provider transfer");
  const fromRef = parseRef(a.from);
  const toRef = parseRef(a.to);
  const srcTop = await g.src.stat(fromRef.path);
  const destParent = await g.dst.stat(toRef.path);
  if (!destParent.isFolder) throw new Error(`${a.to} is not a folder`);
  const r = `${route(g.src, g.dst)} (server-side Drive copy, no bytes pass through this server)`;
  const meta = { actor: opts.actor };

  if (!srcTop.isFolder) {
    if (a.dryRun) {
      return { dryRun: true, from: a.from, to: a.to, route: r, files: 1, folders: 0, bytes: srcTop.size ?? 0, exports: 0, issues: [], truncated: false, estimatedSlices: 1, note: "Nothing was written. One file, copied server-side by Drive." };
    }
    const existing = await g.dst.child(destParent, srcTop.name);
    let outcome: FileOutcome;
    let final: Entry | undefined;
    if (existing) {
      outcome = compareExisting(srcTop, existing, srcTop.googleNative ? existing.size : srcTop.size);
    } else {
      const res = await copyFile({ fromAccount: g.src.label, fileId: srcTop.id, toAccount: g.dst.label, toFolderId: destParent.id }, meta);
      final = await g.dst.statId(res.copy.id);
      const v = srcTop.googleNative ? ({ ok: true, level: "size" } as const) : verify(srcTop, final, srcTop.size ?? 0, undefined);
      outcome = v.ok ? { kind: "copied", bytes: final.size ?? 0, verified: v.level } : { kind: "failed", error: v.error };
    }
    const t = zero();
    const failures: Failure[] = [];
    if (outcome.kind === "copied") {
      t.copied = 1;
      t.bytes = outcome.bytes;
      t[outcome.verified === "hash" ? "verifiedHash" : "verifiedSize"] = 1;
    } else if (outcome.kind === "skipped") {
      t.skipped = 1;
      t[outcome.verified === "hash" ? "verifiedHash" : "verifiedSize"] = 1;
    } else if (outcome.kind === "failed") {
      t.failed = 1;
      failures.push({ path: srcTop.path, error: outcome.error });
    }
    let moveInfo: TransferResult["move"];
    if (g.move) {
      if (t.failed) moveInfo = { trashed: false, reason: "the copy did not verify; nothing was trashed" };
      else {
        await g.src.trash(srcTop);
        await appendAudit({ tool: "trash", account: g.src.label, fileId: srcTop.id, name: srcTop.name, actor: opts.actor, note: `transfer move to ${a.to}` });
        moveInfo = { trashed: true };
      }
    }
    return {
      done: true,
      from: a.from,
      to: a.to,
      route: r,
      copied: t.copied,
      skipped: t.skipped,
      folders: 0,
      bytes: t.bytes,
      failed: failures,
      verified: { hash: t.verifiedHash, size: t.verifiedSize },
      totals: t,
      notes: [],
      move: moveInfo,
      report: `Done: ${t.copied} copied, ${t.skipped} already present, ${t.failed} failed.${moveInfo ? (moveInfo.trashed ? " Source moved to trash." : ` Source not trashed: ${moveInfo.reason}`) : ""}`,
    };
  }

  const res = await copyTree(
    { fromAccount: g.src.label, fileId: srcTop.id, toAccount: g.dst.label, toFolderId: destParent.id, maxFiles: g.maxFiles, resume: g.cursor?.resume, dryRun: a.dryRun },
    meta,
    { budgetMs: a.budgetMs },
  );
  if ("dryRun" in res) {
    const p = res as CopyTreePlan;
    return {
      dryRun: true,
      from: a.from,
      to: a.to,
      route: r,
      files: p.files,
      folders: p.folders,
      bytes: p.bytes,
      exports: 0,
      issues: p.shortcuts ? [{ path: srcTop.path, issue: `${p.shortcuts} shortcut(s) are re-created pointing at the same targets` }] : [],
      truncated: p.truncated,
      estimatedSlices: p.calls,
      note: p.note,
    };
  }
  const t = res as CopyTreeResult;
  const totals: Totals = { copied: t.totals.copiedFiles + t.totals.shortcuts, folders: t.totals.createdFolders, skipped: t.totals.skipped, failed: t.totals.failed, bytes: 0, verifiedHash: 0, verifiedSize: 0 };
  let moveInfo: TransferResult["move"];
  if (g.move && t.done) {
    if (totals.failed > 0) moveInfo = { trashed: false, reason: `${totals.failed} item(s) failed; nothing was trashed` };
    else {
      await g.src.trash(srcTop);
      await appendAudit({ tool: "trash", account: g.src.label, fileId: srcTop.id, name: srcTop.name, actor: opts.actor, note: `transfer move to ${a.to}` });
      moveInfo = { trashed: true };
    }
  } else if (g.move) {
    moveInfo = { trashed: false, reason: "the source is trashed only on the final slice" };
  }
  const cur: GoogleCursor | undefined = t.resume ? { v: 1, kind: "google", from: a.from, to: a.to, move: g.move, resume: t.resume } : undefined;
  return {
    done: t.done,
    cursor: cur ? encodeTransferCursor(cur) : undefined,
    from: a.from,
    to: a.to,
    route: r,
    copied: t.copiedFiles + t.shortcuts,
    skipped: t.skipped,
    folders: t.createdFolders,
    bytes: 0,
    failed: [...t.failures, ...t.retrying].map((f) => ({ path: f.name, error: f.error })),
    verified: { hash: 0, size: 0 },
    totals,
    notes: [t.note],
    move: moveInfo,
    report: `${t.done ? "Done" : "Partial (call again with cursor)"}: ${totals.copied} copied, ${totals.skipped} already present, ${totals.folders} folders, ${totals.failed} failed (server-side copy; Drive copies are not re-hashed).${moveInfo ? (moveInfo.trashed ? " Source moved to trash." : ` Source not trashed: ${moveInfo.reason}`) : ""}`,
  };
}

