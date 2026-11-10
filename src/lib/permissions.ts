/**
 * Sharing: list/grant/revoke permissions, transfer ownership, create shortcuts.
 * Every change is audit-logged. Nothing here deletes a file.
 */
import { assertAccountWritable } from "./access";
import { appendAudit } from "./audit";
import { assertWritable, folderFromPath, ownerEmail, ownerLabel, toResult, type Ctx, type FileResult } from "./ctx";
import { DriveError, type DriveFile, type Permission } from "./drive";
import type { OpMeta } from "./ops";

export type ShareRole = "reader" | "commenter" | "writer";

export interface PermissionRow {
  id: string;
  email?: string;
  role: string;
  type: string;
  displayName?: string;
  pendingOwner?: boolean;
}

function row(p: Permission): PermissionRow {
  return { id: p.id, email: p.emailAddress, role: p.role, type: p.type, displayName: p.displayName, pendingOwner: p.pendingOwner || undefined };
}

/** Sharing needs the owner or an editor with sharing rights; Drive reports this as `capabilities.canShare`. */
export function assertCanShare(f: DriveFile): void {
  if (f.capabilities?.canShare === false) {
    const owner = f.owners?.[0]?.emailAddress ?? "unknown";
    throw new Error(`cannot change sharing of ${f.name} (owner ${owner}): only the owner, or an editor the owner allows to share, can do that.`);
  }
}

function sameEmail(a: string | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

export async function listPermissions(c: Ctx, fileId: string): Promise<{ file: FileResult; permissions: PermissionRow[] }> {
  const file = await c.drive.getFile(fileId);
  const perms = await c.drive.listPermissions(fileId);
  return { file: await toResult(c, file), permissions: perms.map(row) };
}

export interface ShareArgs {
  fileId: string;
  email: string;
  role: ShareRole;
  notify?: boolean;
  message?: string;
}

export interface SharePreview {
  dryRun: true;
  file: FileResult;
  message: string;
  mutates: boolean;
  existing?: PermissionRow;
}

export async function shareFile(c: Ctx, a: ShareArgs & { dryRun?: boolean }, meta: OpMeta): Promise<{ file: FileResult; permission: PermissionRow } | SharePreview> {
  assertAccountWritable(c.account);
  const file = await c.drive.getFile(a.fileId);
  assertCanShare(file);
  if (a.dryRun) {
    const existing = (await c.drive.listPermissions(a.fileId)).find((p) => sameEmail(p.emailAddress, a.email));
    const same = existing?.role === a.role;
    return {
      dryRun: true,
      file: await toResult(c, file),
      mutates: !same,
      existing: existing ? row(existing) : undefined,
      message: same
        ? `${a.email} already has ${a.role} access to ${file.name} (nothing to do)`
        : `grant ${a.email} ${a.role} access to ${file.name}${existing ? ` (currently ${existing.role})` : ""}${a.notify ? ", with a notification e-mail" : ", no e-mail"}`,
    };
  }
  const perm = await c.drive.createPermission(
    a.fileId,
    { type: "user", role: a.role, emailAddress: a.email },
    { sendNotificationEmail: a.notify ?? false, emailMessage: a.notify ? a.message : undefined },
  );
  await appendAudit({ tool: "share", account: c.account.label, fileId: file.id, name: file.name, email: a.email, role: a.role, owner: ownerLabel(c, file), actor: meta.actor, batchId: meta.batchId });
  return { file: await toResult(c, file), permission: row(perm) };
}

export async function unshareFile(c: Ctx, a: { fileId: string; email: string; dryRun?: boolean }, meta: OpMeta): Promise<{ file: FileResult; removed: PermissionRow } | SharePreview> {
  assertAccountWritable(c.account);
  const file = await c.drive.getFile(a.fileId);
  assertCanShare(file);
  const perms = await c.drive.listPermissions(a.fileId);
  const hit = perms.find((p) => sameEmail(p.emailAddress, a.email));
  if (!hit) {
    const have = perms.map((p) => p.emailAddress).filter(Boolean).join(", ") || "none";
    throw new Error(`${a.email} has no permission on ${file.name} (current: ${have})`);
  }
  if (hit.role === "owner") throw new Error(`${a.email} owns ${file.name}; an owner's access cannot be removed (use transfer_ownership first).`);
  if (a.dryRun) return { dryRun: true, file: await toResult(c, file), mutates: true, existing: row(hit), message: `remove ${a.email}'s ${hit.role} access to ${file.name}` };
  await c.drive.removePermission(a.fileId, hit.id);
  await appendAudit({ tool: "unshare", account: c.account.label, fileId: file.id, name: file.name, email: a.email, role: hit.role, owner: ownerLabel(c, file), actor: meta.actor, batchId: meta.batchId });
  return { file: await toResult(c, file), removed: row(hit) };
}

const CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function domainOf(email: string): string {
  return email.toLowerCase().split("@")[1] ?? "";
}

/** Direct transfer is only possible between two accounts of the same Google Workspace domain. */
export function canTransferDirectly(fromEmail: string, toEmail: string): boolean {
  const from = domainOf(fromEmail);
  return from !== "" && from === domainOf(toEmail) && !CONSUMER_DOMAINS.has(from);
}

export interface TransferResult {
  file: FileResult;
  toEmail: string;
  /** `transferred`: done. `pending`: the recipient must accept the invitation in Drive before ownership changes. */
  mode: "transferred" | "pending";
  permission: PermissionRow;
  note: string;
}

export async function transferOwnership(c: Ctx, a: { fileId: string; toEmail: string }, meta: OpMeta): Promise<TransferResult> {
  assertAccountWritable(c.account);
  const file = await c.drive.getFile(a.fileId);
  if (file.driveId) throw new Error(`${file.name} is in a Shared Drive; Shared Drive items are owned by the drive, not by a person.`);
  const owner = ownerEmail(file);
  if (owner && owner !== c.ownEmail) {
    throw new Error(`only the owner can transfer ownership of ${file.name} (owner ${owner}, you are ${c.ownEmail}).`);
  }
  if (sameEmail(a.toEmail, c.ownEmail)) throw new Error(`${a.toEmail} already owns ${file.name}.`);

  let mode: TransferResult["mode"] = "pending";
  let perm: Permission | undefined;
  let note = "";
  if (canTransferDirectly(c.ownEmail, a.toEmail)) {
    try {
      // Drive requires the notification e-mail for ownership transfers.
      perm = await c.drive.createPermission(a.fileId, { type: "user", role: "owner", emailAddress: a.toEmail }, { sendNotificationEmail: true, transferOwnership: true });
      mode = "transferred";
      note = `${a.toEmail} now owns ${file.name}; ${c.ownEmail} was downgraded to editor.`;
    } catch (e) {
      if (!(e instanceof DriveError)) throw e;
      note = `Direct transfer was refused by Drive (${e.message}); fell back to an ownership invitation. `;
    }
  }
  if (!perm) {
    // Consumer (Gmail) accounts and cross-domain transfers: invite the recipient as pending owner; they must accept in Drive.
    const existing = (await c.drive.listPermissions(a.fileId)).find((p) => sameEmail(p.emailAddress, a.toEmail));
    const target = existing ?? (await c.drive.createPermission(a.fileId, { type: "user", role: "writer", emailAddress: a.toEmail }, { sendNotificationEmail: false }));
    perm = await c.drive.updatePermission(a.fileId, target.id, { role: "writer", pendingOwner: true });
    note +=
      `${a.toEmail} has been invited to own ${file.name} (editor with pendingOwner). The recipient must accept the transfer in Google Drive ` +
      `(open the file > Share > accept ownership); until then ${c.ownEmail} remains the owner.`;
  }
  await appendAudit({
    tool: "transfer_ownership",
    account: c.account.label,
    fileId: file.id,
    name: file.name,
    email: a.toEmail,
    role: mode === "transferred" ? "owner" : "pendingOwner",
    owner: ownerLabel(c, file),
    actor: meta.actor,
    batchId: meta.batchId,
  });
  return { file: await toResult(c, file), toEmail: a.toEmail, mode, permission: row(perm), note };
}

export interface ShortcutArgs {
  targetId: string;
  path?: string;
  folderId?: string;
  name?: string;
}

export async function createShortcut(c: Ctx, a: ShortcutArgs, meta: OpMeta): Promise<FileResult & { targetId: string; targetPath: string }> {
  assertAccountWritable(c.account);
  if (!a.path && !a.folderId) throw new Error("Give path or folderId for the folder that should hold the shortcut");
  const target = await c.drive.getFile(a.targetId);
  const folderId = a.folderId ?? (await folderFromPath(c, a.path!));
  assertWritable(await c.drive.getFile(folderId), "addChildren");
  const shortcut = await c.drive.createShortcut(a.name ?? target.name, a.targetId, folderId);
  await appendAudit({ tool: "shortcut", account: c.account.label, fileId: shortcut.id, name: shortcut.name, from: a.targetId, to: folderId, owner: ownerLabel(c, shortcut), actor: meta.actor, batchId: meta.batchId });
  const targetResult = await toResult(c, target);
  return { ...(await toResult(c, shortcut)), targetId: a.targetId, targetPath: targetResult.path };
}
