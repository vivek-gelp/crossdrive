/**
 * `batch`: many move/rename/trash/copy/mkdir operations in one call. A dry
 * run resolves every operation (paths to ids, current names, view-only check,
 * destination exists, name conflicts) and reports what would happen;
 * execution runs the same single-op functions from ops.ts sequentially under
 * one batchId. The summary counts mutations per op type, so "ok" items that
 * changed nothing (folder already existed, item already there) are visible.
 */
import { randomUUID } from "node:crypto";
import { ctxFor } from "./ctx";
import {
  copyFile,
  makeFolder,
  moveFile,
  planMove,
  planRename,
  planTrash,
  previewCopy,
  previewMkdir,
  previewMove,
  previewRename,
  previewTrash,
  renameFile,
  setFileTrashed,
  type CopyArgs,
  type ItemSummary,
  type MkdirArgs,
  type MoveArgs,
  type OpPreview,
  type RenameArgs,
} from "./ops";

export const MAX_BATCH_OPS = 100;

export type BatchOp =
  | ({ op: "move"; account: string } & MoveArgs)
  | ({ op: "rename"; account: string } & RenameArgs)
  | { op: "trash"; account: string; fileId: string }
  | ({ op: "copy" } & CopyArgs)
  | ({ op: "mkdir"; account: string } & MkdirArgs);

export type BatchOpName = BatchOp["op"];
export type BatchStatus = "ready" | "ok" | "error" | "skipped";

export interface BatchItem {
  index: number;
  op: BatchOpName;
  status: BatchStatus;
  message: string;
  /** Executed: true when Drive was changed. Dry run: true when executing would change Drive. */
  mutates?: boolean;
  /** Audit entry id of an executed op (pass to undo). */
  auditId?: string;
  before?: Partial<ItemSummary> & { account?: string };
  after?: Record<string, unknown>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function fromPreview(index: number, o: BatchOp, p: OpPreview): BatchItem {
  return { index, op: o.op, status: "ready", message: p.message, mutates: p.mutates, before: p.before, after: p.after };
}

/** Resolve one op without changing anything. */
async function preview(index: number, o: BatchOp): Promise<BatchItem> {
  try {
    switch (o.op) {
      case "move":
        return fromPreview(index, o, await previewMove(await ctxFor(o.account), o));
      case "rename":
        return fromPreview(index, o, await previewRename(await ctxFor(o.account), o));
      case "trash":
        return fromPreview(index, o, await previewTrash(await ctxFor(o.account), o.fileId, true));
      case "copy":
        return fromPreview(index, o, await previewCopy(o));
      case "mkdir":
        return fromPreview(index, o, await previewMkdir(await ctxFor(o.account), o));
    }
  } catch (e) {
    return { index, op: o.op, status: "error", message: errorMessage(e) };
  }
}

/** Execute one op; the message describes what happened. */
async function execute(index: number, o: BatchOp, meta: { actor: string; batchId: string }): Promise<BatchItem> {
  try {
    switch (o.op) {
      case "move": {
        const c = await ctxFor(o.account);
        const p = await planMove(c, o);
        const r = await moveFile(c, o, meta, p);
        const message = r.unchanged ? `${r.name} was already in ${p.toPath}` : `moved ${r.name} to ${p.toPath}`;
        return { index, op: o.op, status: "ok", message, mutates: !r.unchanged, auditId: r.auditId, before: p.before, after: { id: r.id, name: r.name, path: r.path } };
      }
      case "rename": {
        const c = await ctxFor(o.account);
        const p = await planRename(c, o);
        const r = await renameFile(c, o, meta, p);
        const message = r.unchanged ? `${r.name} already had that name` : `renamed ${p.before.name} to ${r.name}`;
        return { index, op: o.op, status: "ok", message, mutates: !r.unchanged, auditId: r.auditId, before: p.before, after: { id: r.id, name: r.name, path: r.path } };
      }
      case "trash": {
        const c = await ctxFor(o.account);
        const p = await planTrash(c, o.fileId);
        const r = await setFileTrashed(c, o.fileId, true, meta, p);
        return { index, op: o.op, status: "ok", message: `trashed ${r.name}`, mutates: true, auditId: r.auditId, before: p.before, after: { id: r.id, name: r.name, path: r.path, trashed: true } };
      }
      case "copy": {
        const r = await copyFile(o, meta);
        return {
          index,
          op: o.op,
          status: "ok",
          message: `copied ${r.source.name} to ${r.copy.path}${r.source.trashed ? " and trashed the source" : ""}`,
          mutates: true,
          before: { id: r.source.id, name: r.source.name, path: r.source.path, owner: r.source.owner, canEdit: r.source.canEdit, account: o.fromAccount },
          after: { id: r.copy.id, name: r.copy.name, path: r.copy.path, account: o.toAccount },
        };
      }
      case "mkdir": {
        const r = await makeFolder(await ctxFor(o.account), o, meta);
        return {
          index,
          op: o.op,
          status: "ok",
          message: r.created ? `created folder ${r.path}` : `folder ${r.path} already existed`,
          mutates: r.created,
          auditId: r.auditId,
          after: { id: r.id, name: r.name, path: r.path, created: r.created },
        };
      }
    }
  } catch (e) {
    return { index, op: o.op, status: "error", message: errorMessage(e) };
  }
}

export type MutationCounts = Record<BatchOpName, number> & { total: number };

export interface BatchResult {
  dryRun: boolean;
  batchId?: string;
  items: BatchItem[];
  /**
   * Item counts by status, plus `mutations`: per op type, how many items
   * changed Drive (executed) or would change it (dry run).
   */
  summary: Record<BatchStatus, number> & { total: number; mutations: MutationCounts };
}

function summarize(items: BatchItem[]): BatchResult["summary"] {
  const mutations: MutationCounts = { move: 0, rename: 0, trash: 0, copy: 0, mkdir: 0, total: 0 };
  const s: BatchResult["summary"] = { total: items.length, ready: 0, ok: 0, error: 0, skipped: 0, mutations };
  for (const i of items) {
    s[i.status]++;
    if ((i.status === "ok" || i.status === "ready") && i.mutates) {
      mutations[i.op]++;
      mutations.total++;
    }
  }
  return s;
}

export function checkBatchSize(ops: unknown[]): void {
  if (ops.length === 0) throw new Error("operations is empty");
  if (ops.length > MAX_BATCH_OPS) throw new Error(`Too many operations (${ops.length}); the maximum is ${MAX_BATCH_OPS} per batch call`);
}

/** Dry run: resolve every op, change nothing. Ops are previewed sequentially so error messages are stable. */
export async function previewBatch(ops: BatchOp[]): Promise<BatchResult> {
  checkBatchSize(ops);
  const items: BatchItem[] = [];
  for (const [index, o] of ops.entries()) items.push(await preview(index, o));
  return { dryRun: true, items, summary: summarize(items) };
}

export async function executeBatch(ops: BatchOp[], opts: { actor: string; stopOnError: boolean }): Promise<BatchResult> {
  checkBatchSize(ops);
  const batchId = randomUUID();
  const items: BatchItem[] = [];
  let stopped = false;
  for (const [index, o] of ops.entries()) {
    if (stopped) {
      items.push({ index, op: o.op, status: "skipped", message: "skipped: an earlier operation failed and stopOnError is set" });
      continue;
    }
    const item = await execute(index, o, { actor: opts.actor, batchId });
    items.push(item);
    if (item.status === "error" && opts.stopOnError) stopped = true;
  }
  return { dryRun: false, batchId, items, summary: summarize(items) };
}
