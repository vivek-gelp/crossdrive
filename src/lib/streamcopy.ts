/**
 * The copy tool's streaming route for a cross-account Google -> Google copy (see copyroute.ts for when it is
 * chosen): a thin wrapper over the transfer engine (providers/transfer.ts `streamById`) that keeps the copy tool's
 * argument names (`resume`, `maxFiles`, `newName`) and adds the source and the created copy as FileResults.
 * Files and folder trees alike; the resume cursor follows the transfer engine's semantics.
 */
import { ctxFor, toResult, type FileResult } from "./ctx";
import type { OpMeta } from "./ops";
import { streamById, type TransferPlan, type TransferResult } from "./providers/transfer";

export interface StreamCopyArgs {
  fromAccount: string;
  fileId: string;
  toAccount: string;
  toFolderId: string;
  newName?: string;
  resume?: string;
  dryRun?: boolean;
  maxFiles?: number;
  budgetMs?: number;
}

export type StreamCopyResult = Omit<TransferResult, "cursor"> & {
  kind: "file" | "folder";
  method: "stream";
  crossAccount: true;
  reason: string;
  source: FileResult;
  /** Single file, once created. */
  copy?: FileResult;
  /** Pass back as `resume` (with the same arguments) to continue; absent when done. */
  resume?: string;
  note: string;
};

export type StreamCopyPlan = TransferPlan & { kind: "file" | "folder"; method: "stream"; crossAccount: true; reason: string; source: FileResult };

export async function streamCopy(a: StreamCopyArgs, reason: string, meta: OpMeta): Promise<StreamCopyResult | StreamCopyPlan> {
  const src = await ctxFor(a.fromAccount);
  const file = await src.drive.getFile(a.fileId);
  const source = await toResult(src, file);
  const kind = file.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file";
  const r = await streamById(
    { fromAccount: a.fromAccount, fileId: a.fileId, toAccount: a.toAccount, toFolderId: a.toFolderId, newName: a.newName, cursor: a.resume, dryRun: a.dryRun, maxFiles: a.maxFiles, budgetMs: a.budgetMs, reason },
    { actor: meta.actor },
  );
  if ("dryRun" in r) return { ...r, kind, method: "stream", crossAccount: true, reason, source };
  const { cursor, ...rest } = r;
  let copy: FileResult | undefined;
  const created = kind === "file" ? r.created[0] : undefined;
  if (created) {
    const dst = await ctxFor(a.toAccount);
    copy = await toResult(dst, await dst.drive.getFile(created.id));
  }
  return {
    ...rest,
    kind,
    method: "stream",
    crossAccount: true,
    reason,
    source,
    ...(copy ? { copy } : {}),
    ...(cursor ? { resume: cursor } : {}),
    note:
      `Copied by streaming through this server because ${reason}. No permission was created on the source.` +
      (r.converted.length ? ` Google Docs/Sheets/Slides were exported and imported back: comments, revision history and some formatting are not preserved.` : "") +
      (r.notCopied.length ? ` ${r.notCopied.length} item(s) were not copied (see notCopied).` : "") +
      (cursor ? " Not finished: call copy again with the same arguments plus this resume cursor." : ""),
  };
}
