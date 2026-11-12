/**
 * `undo`: reverse move, rename, trash and untrash from their audit entries
 * (one entry by id, or every entry of a batch, newest first). The current
 * state is checked first, so an item that changed again since is left alone
 * with an explanation. Anything else (copies, uploads, sharing, mail, ...) is
 * refused with what to do instead. Every reversal is itself audited
 * (tool "undo", undoOf = the reversed entry).
 */
import { assertAccountWritable } from "./access";
import { appendAudit, findBatchEntries, getAuditEntry, type StoredAuditEntry } from "./audit";
import { ctxFor, ownerLabel, type Ctx } from "./ctx";
import { pathResolver } from "./paths";
import { getSource } from "./ops";

export const UNDOABLE_TOOLS = ["move", "rename", "trash", "untrash"] as const;

export interface UndoItem {
  entryId: string;
  tool: string;
  account: string;
  fileId?: string;
  name?: string;
  status: "undone" | "ready" | "refused" | "error";
  message: string;
  /** Audit id of the reversal (executed undo only). */
  auditId?: string;
}

export interface UndoResult {
  dryRun: boolean;
  items: UndoItem[];
  summary: { total: number; undone: number; ready: number; refused: number; error: number };
}

function refusal(e: StoredAuditEntry): string {
  switch (e.tool) {
    case "copy":
      return `copies are not undone automatically; if the copy is unwanted, trash it (fileId ${e.fileId} in ${e.toAccount ?? e.account}).`;
    case "mkdir":
    case "put":
    case "upload_begin":
    case "upload_finish":
    case "shortcut":
    case "mail_attachment":
      return `creations are not undone automatically; trash the created item${e.fileId ? ` (fileId ${e.fileId})` : ""} if it is unwanted.`;
    case "share":
      return `undo a share with unshare (${e.email ?? "the person"} on fileId ${e.fileId}).`;
    case "unshare":
      return `undo an unshare with share (${e.email ?? "the person"}, role ${e.role ?? "?"}, fileId ${e.fileId}).`;
    case "transfer_ownership":
      return "ownership transfers cannot be reversed by the previous owner; ask the new owner to transfer it back.";
    case "mail_send":
    case "mail_reply":
      return "sent mail cannot be recalled.";
    case "mail_draft":
      return "drafts are not undone here; delete the draft in Gmail if it is unwanted.";
    case "mail_label":
      return `undo a label change with mail_label (add ${JSON.stringify(e.remove ?? [])}, remove ${JSON.stringify(e.add ?? [])}).`;
    case "undo":
      return "an undo is not undone; run the opposite operation instead.";
    default:
      return `only ${UNDOABLE_TOOLS.join(", ")} can be undone.`;
  }
}

async function folderPath(c: Ctx, id: string): Promise<string> {
  return pathResolver.displayPath(c.account.label, c.drive, id, c.rootId).catch(() => id);
}

async function undoOne(e: StoredAuditEntry, actor: string, dryRun: boolean): Promise<UndoItem> {
  const base = { entryId: e.id, tool: e.tool, account: e.account, fileId: e.fileId, name: e.name };
  if (!(UNDOABLE_TOOLS as readonly string[]).includes(e.tool) || !e.fileId) {
    return { ...base, status: "refused", message: `cannot undo ${e.tool}: ${refusal(e)}` };
  }
  try {
    const c = await ctxFor(e.account);
    await assertAccountWritable(c.account);
    const file = await getSource(c, e.fileId);
    const audit = (extra: { from?: string; to?: string }) =>
      appendAudit({ tool: "undo", undoOf: e.id, undoneTool: e.tool, account: e.account, fileId: file.id, name: file.name, owner: ownerLabel(c, file), actor, ...extra });

    if (e.tool === "move") {
      const from = (e.from ?? "").split(",").filter(Boolean);
      const to = e.to;
      if (!from.length || !to) return { ...base, status: "refused", message: "the audit entry does not record the original folder" };
      if (!(file.parents ?? []).includes(to)) return { ...base, status: "refused", message: `${file.name} is no longer in the folder it was moved to; it was changed since, so it is left alone` };
      const clash = await c.drive.findChildByName(from[0]!, file.name, false);
      if (clash && clash.id !== file.id) return { ...base, status: "refused", message: `the original folder already holds another item named "${file.name}" (id ${clash.id})` };
      const back = await folderPath(c, from[0]!);
      if (dryRun) return { ...base, status: "ready", message: `move ${file.name} back to ${back}` };
      await c.drive.move(file.id, from.join(","), [to]);
      const entry = await audit({ from: to, to: from.join(",") });
      return { ...base, status: "undone", message: `moved ${file.name} back to ${back}`, auditId: entry.id };
    }
    if (e.tool === "rename") {
      if (!e.from || !e.to) return { ...base, status: "refused", message: "the audit entry does not record both names" };
      if (file.name !== e.to) return { ...base, status: "refused", message: `${file.name} is no longer named "${e.to}"; it was changed since, so it is left alone` };
      for (const parent of file.parents ?? []) {
        const clash = await c.drive.findChildByName(parent, e.from, false);
        if (clash && clash.id !== file.id) return { ...base, status: "refused", message: `another item named "${e.from}" (id ${clash.id}) now sits next to it` };
      }
      if (dryRun) return { ...base, status: "ready", message: `rename ${file.name} back to ${e.from}` };
      await c.drive.rename(file.id, e.from);
      const entry = await audit({ from: e.to, to: e.from });
      return { ...base, status: "undone", message: `renamed ${e.to} back to ${e.from}`, auditId: entry.id };
    }
    // trash / untrash
    const wasTrashed = e.tool === "trash";
    if ((file.trashed ?? false) !== wasTrashed) {
      return { ...base, status: "refused", message: `${file.name} is ${file.trashed ? "in" : "out of"} the trash already; nothing to undo` };
    }
    if (dryRun) return { ...base, status: "ready", message: `${wasTrashed ? "restore" : "trash"} ${file.name}` };
    await c.drive.setTrashed(file.id, !wasTrashed);
    const entry = await audit({});
    return { ...base, status: "undone", message: `${wasTrashed ? "restored" : "trashed"} ${file.name}`, auditId: entry.id };
  } catch (err) {
    return { ...base, status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function undo(target: { id?: string; batchId?: string }, opts: { actor: string; dryRun: boolean }): Promise<UndoResult> {
  if (!target.id === !target.batchId) throw new Error("Give exactly one of id (an audit entry id) or batchId");
  let entries: StoredAuditEntry[];
  if (target.id) {
    const e = await getAuditEntry(target.id);
    if (!e) throw new Error(`No audit entry with id ${target.id}; ids are listed by the audit tool`);
    entries = [e];
  } else {
    entries = await findBatchEntries(target.batchId!);
    if (!entries.length) throw new Error(`No audit entries for batchId ${target.batchId} in the recent audit log`);
  }
  const items: UndoItem[] = [];
  // Newest first, so later operations on the same item are reversed before earlier ones.
  for (const e of entries) items.push(await undoOne(e, opts.actor, opts.dryRun));
  const summary = { total: items.length, undone: 0, ready: 0, refused: 0, error: 0 };
  for (const i of items) summary[i.status]++;
  return { dryRun: opts.dryRun, items, summary };
}
