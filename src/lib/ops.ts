/**
 * The write operations behind the mkdir/move/rename/trash/untrash/copy tools,
 * as functions so that `batch` can reuse them. Each op has a `plan*` step that
 * resolves paths and runs the guards without touching Drive state (used by
 * dry runs, single and batch) and an executing function that applies the
 * plan and writes the audit entry.
 *
 * Guards, in order: the account's mode (read-only accounts refuse every
 * write), the source exists, the target folder exists and is a folder, Drive
 * capabilities (view-only items), and name conflicts (moving or renaming onto
 * an existing item of the same name is refused instead of creating a
 * same-named duplicate).
 */
import { assertAccountWritable } from "./access";
import { appendAudit } from "./audit";
import { assertWritable, checkName, ctxFor, folderFromPath, inboxFolder, ownerLabel, targetFolder, toResult, type Ctx, type FileResult } from "./ctx";
import { DriveError, FOLDER_MIME, type DriveFile } from "./drive";
import { pathResolver } from "./paths";

export interface OpMeta {
  actor: string;
  /** Shared by every op executed in one `batch` call. */
  batchId?: string;
}

/** Compact description of an item before/after an op, for previews and batch reports. */
export interface ItemSummary {
  id: string;
  name: string;
  path: string;
  owner: string;
  canEdit: boolean;
}

/** What a dry run reports for one op. `mutates` is false when executing would change nothing. */
export interface OpPreview {
  dryRun: true;
  op: string;
  message: string;
  mutates: boolean;
  before?: Partial<ItemSummary> & { account?: string };
  after?: Record<string, unknown>;
}

async function summary(c: Ctx, f: DriveFile): Promise<ItemSummary> {
  const r = await toResult(c, f);
  return { id: r.id, name: r.name, path: r.path, owner: r.owner, canEdit: r.canEdit };
}

async function folderPath(c: Ctx, folderId: string): Promise<string> {
  return pathResolver.displayPath(c.account.label, c.drive, folderId, c.rootId);
}

function joinPath(folder: string, name: string): string {
  return `${folder.replace(/\/$/, "")}/${name}`;
}

/** files.get with a clear error when the item does not exist (or the account cannot see it). */
export async function getSource(c: Ctx, fileId: string): Promise<DriveFile> {
  try {
    return await c.drive.getFile(fileId);
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) {
      throw new Error(`source not found: no file or folder with id ${fileId} is visible to account ${c.account.label} (deleted, or never shared with it)`);
    }
    throw e;
  }
}

/** The destination folder, checked to exist and to be a folder. */
export async function getTargetFolder(c: Ctx, folderId: string): Promise<DriveFile> {
  let f: DriveFile;
  try {
    f = await c.drive.getFile(folderId);
  } catch (e) {
    if (e instanceof DriveError && e.status === 404) throw new Error(`target folder not found: no folder with id ${folderId} is visible to account ${c.account.label}`);
    throw e;
  }
  if (f.mimeType && f.mimeType !== FOLDER_MIME) throw new Error(`target ${f.name} (${folderId}) is not a folder`);
  return f;
}

/** Refuse when `parentId` already holds another item named `name`. */
async function assertNoNameClash(c: Ctx, parentId: string, name: string, selfId: string, verb: string): Promise<void> {
  const clash = await c.drive.findChildByName(parentId, name, false);
  if (clash && clash.id !== selfId) {
    const where = await folderPath(c, parentId);
    throw new Error(
      `conflict: ${where} already contains an item named "${name}" (id ${clash.id}); nothing was ${verb}. Rename one of them first, or choose another destination.`,
    );
  }
}

// ---- mkdir -----------------------------------------------------------------

export interface MkdirArgs {
  parentPath?: string;
  parentId?: string;
  name: string;
}

export interface MkdirPlan {
  parentId: string;
  parentPath: string;
  existing?: DriveFile;
}

export async function planMkdir(c: Ctx, a: MkdirArgs): Promise<MkdirPlan> {
  assertAccountWritable(c.account);
  const parentId = a.parentId ?? (await folderFromPath(c, a.parentPath ?? "/"));
  const existing = await c.drive.findChildByName(parentId, a.name, true);
  if (!existing) assertWritable(await c.drive.getFile(parentId), "addChildren");
  return { parentId, parentPath: await folderPath(c, parentId), existing };
}

export async function previewMkdir(c: Ctx, a: MkdirArgs): Promise<OpPreview> {
  const p = await planMkdir(c, a);
  return {
    dryRun: true,
    op: "mkdir",
    mutates: !p.existing,
    message: p.existing ? `folder ${a.name} already exists in ${p.parentPath} (nothing to do)` : `create folder ${a.name} in ${p.parentPath}`,
    after: { path: joinPath(p.parentPath, a.name), parentId: p.parentId, exists: !!p.existing },
  };
}

export async function makeFolder(c: Ctx, a: MkdirArgs, meta: OpMeta, plan?: MkdirPlan): Promise<FileResult & { created: boolean; auditId?: string }> {
  plan ??= await planMkdir(c, a);
  let folder = plan.existing;
  let auditId: string | undefined;
  if (!folder) {
    folder = await c.drive.createFolder(a.name, plan.parentId);
    auditId = (
      await appendAudit({
        tool: "mkdir",
        account: c.account.label,
        fileId: folder.id,
        name: folder.name,
        to: plan.parentId,
        owner: ownerLabel(c, folder),
        actor: meta.actor,
        batchId: meta.batchId,
      })
    ).id;
  }
  return { ...(await toResult(c, folder)), created: !plan.existing, ...(auditId ? { auditId } : {}) };
}

// ---- move ------------------------------------------------------------------

export interface MoveArgs {
  fileId: string;
  toPath?: string;
  toFolderId?: string;
}

export interface MovePlan {
  file: DriveFile;
  before: ItemSummary;
  toFolderId: string;
  toPath: string;
  /** The item already sits in the target folder: executing changes nothing. */
  alreadyThere: boolean;
}

export async function planMove(c: Ctx, a: MoveArgs): Promise<MovePlan> {
  assertAccountWritable(c.account);
  const file = await getSource(c, a.fileId);
  const toFolderId = await targetFolder(c, a, `/${inboxFolder()}`);
  const target = await getTargetFolder(c, toFolderId);
  assertWritable(file, "edit");
  assertWritable(target, "addChildren");
  if (toFolderId === file.id) throw new Error(`cannot move ${file.name} into itself`);
  const alreadyThere = (file.parents ?? []).includes(toFolderId);
  if (!alreadyThere) await assertNoNameClash(c, toFolderId, file.name, file.id, "moved");
  return { file, before: await summary(c, file), toFolderId, toPath: await folderPath(c, toFolderId), alreadyThere };
}

export async function previewMove(c: Ctx, a: MoveArgs): Promise<OpPreview> {
  const p = await planMove(c, a);
  return {
    dryRun: true,
    op: "move",
    mutates: !p.alreadyThere,
    message: p.alreadyThere ? `${p.before.name} is already in ${p.toPath} (nothing to do)` : `move ${p.before.name} to ${p.toPath}`,
    before: p.before,
    after: { path: joinPath(p.toPath, p.before.name), folderId: p.toFolderId },
  };
}

export async function moveFile(c: Ctx, a: MoveArgs, meta: OpMeta, plan?: MovePlan): Promise<FileResult & { unchanged?: true; auditId?: string }> {
  plan ??= await planMove(c, a);
  if (plan.alreadyThere) return { ...(await toResult(c, plan.file)), unchanged: true };
  let file: DriveFile;
  try {
    file = await c.drive.move(a.fileId, plan.toFolderId, plan.file.parents ?? []);
  } catch (e) {
    if (e instanceof DriveError) {
      throw new Error(`Drive refused to move ${plan.file.name} (owner ${ownerLabel(c, plan.file)}): ${e.message}`);
    }
    throw e;
  }
  const entry = await appendAudit({
    tool: "move",
    account: c.account.label,
    fileId: file.id,
    name: file.name,
    from: plan.file.parents?.join(","),
    to: plan.toFolderId,
    owner: ownerLabel(c, file),
    actor: meta.actor,
    batchId: meta.batchId,
  });
  return { ...(await toResult(c, file)), auditId: entry.id };
}

// ---- rename ----------------------------------------------------------------

export interface RenameArgs {
  fileId: string;
  newName: string;
  allowNonStandardName?: boolean;
}

export interface RenamePlan {
  file: DriveFile;
  before: ItemSummary;
  /** newName equals the current name: executing changes nothing. */
  unchanged: boolean;
}

export async function planRename(c: Ctx, a: RenameArgs): Promise<RenamePlan> {
  assertAccountWritable(c.account);
  const file = await getSource(c, a.fileId);
  assertWritable(file, "edit");
  const unchanged = file.name === a.newName;
  if (!unchanged) {
    checkName(a.newName, file.mimeType, a.allowNonStandardName ?? false);
    for (const parent of file.parents ?? []) await assertNoNameClash(c, parent, a.newName, file.id, "renamed");
  }
  return { file, before: await summary(c, file), unchanged };
}

export async function previewRename(c: Ctx, a: RenameArgs): Promise<OpPreview> {
  const p = await planRename(c, a);
  return {
    dryRun: true,
    op: "rename",
    mutates: !p.unchanged,
    message: p.unchanged ? `${p.before.name} already has that name (nothing to do)` : `rename ${p.before.name} to ${a.newName}`,
    before: p.before,
    after: { name: a.newName },
  };
}

export async function renameFile(c: Ctx, a: RenameArgs, meta: OpMeta, plan?: RenamePlan): Promise<FileResult & { unchanged?: true; auditId?: string }> {
  plan ??= await planRename(c, a);
  if (plan.unchanged) return { ...(await toResult(c, plan.file)), unchanged: true };
  const file = await c.drive.rename(a.fileId, a.newName);
  const entry = await appendAudit({
    tool: "rename",
    account: c.account.label,
    fileId: file.id,
    name: file.name,
    from: plan.file.name,
    to: a.newName,
    owner: ownerLabel(c, file),
    actor: meta.actor,
    batchId: meta.batchId,
  });
  return { ...(await toResult(c, file)), auditId: entry.id };
}

// ---- trash / untrash -------------------------------------------------------

export interface TrashPlan {
  file: DriveFile;
  before: ItemSummary;
}

export async function planTrash(c: Ctx, fileId: string): Promise<TrashPlan> {
  assertAccountWritable(c.account);
  const file = await getSource(c, fileId);
  assertWritable(file, "edit");
  return { file, before: await summary(c, file) };
}

export async function previewTrash(c: Ctx, fileId: string, trashed: boolean): Promise<OpPreview> {
  const p = await planTrash(c, fileId);
  const already = (p.file.trashed ?? false) === trashed;
  const verb = trashed ? "trash" : "restore";
  return {
    dryRun: true,
    op: trashed ? "trash" : "untrash",
    mutates: !already,
    message: already ? `${p.before.name} is already ${trashed ? "in the trash" : "out of the trash"} (nothing to do)` : `${verb} ${p.before.name}`,
    before: p.before,
    after: { trashed },
  };
}

export async function setFileTrashed(c: Ctx, fileId: string, trashed: boolean, meta: OpMeta, plan?: TrashPlan): Promise<FileResult & { trashed: boolean; auditId: string }> {
  plan ??= await planTrash(c, fileId);
  const file = await c.drive.setTrashed(fileId, trashed);
  const entry = await appendAudit({
    tool: trashed ? "trash" : "untrash",
    account: c.account.label,
    fileId: file.id,
    name: file.name,
    owner: ownerLabel(c, file),
    actor: meta.actor,
    batchId: meta.batchId,
  });
  return { ...(await toResult(c, file)), trashed, auditId: entry.id };
}

// ---- copy ------------------------------------------------------------------

export interface CopyArgs {
  fromAccount: string;
  fileId: string;
  toAccount: string;
  toPath?: string;
  toFolderId?: string;
  newName?: string;
  allowNonStandardName?: boolean;
  trashOriginal?: boolean;
}

export interface CopyPlan {
  src: Ctx;
  dst: Ctx;
  file: DriveFile;
  before: ItemSummary;
  toFolderId: string;
  toPath: string;
  name: string;
  crossAccount: boolean;
}

export interface CopyResult {
  source: FileResult & { trashed: boolean };
  copy: FileResult;
  crossAccount: boolean;
  note?: string;
}

/** Mode checks for a copy (also used by the folder copier's tool handler): the destination must be writable, the source too when it is trashed afterwards. */
export function assertCopyAllowed(src: Ctx, dst: Ctx, trashOriginal: boolean | undefined): void {
  assertAccountWritable(dst.account);
  if (trashOriginal) assertAccountWritable(src.account);
}

export async function planCopy(a: CopyArgs): Promise<CopyPlan> {
  const src = await ctxFor(a.fromAccount);
  const dst = a.toAccount === a.fromAccount ? src : await ctxFor(a.toAccount);
  assertCopyAllowed(src, dst, a.trashOriginal);
  const file = await getSource(src, a.fileId);
  if (file.mimeType === FOLDER_MIME) {
    throw new Error(`${file.name} is a folder: use the copy tool directly (it copies folders recursively in resumable slices); batch copies single files only.`);
  }
  if (!a.toPath && !a.toFolderId) throw new Error("Give toPath or toFolderId for the destination folder");
  const toFolderId = await targetFolder(dst, a);
  assertWritable(await getTargetFolder(dst, toFolderId), "addChildren");
  if (a.trashOriginal) assertWritable(file, "edit");
  const name = a.newName ?? file.name;
  // A copy keeping its original name is never blocked; a new name must follow the naming rule unless overridden.
  checkName(name, file.mimeType, a.newName === undefined || (a.allowNonStandardName ?? false));
  return { src, dst, file, before: await summary(src, file), toFolderId, toPath: await folderPath(dst, toFolderId), name, crossAccount: src !== dst };
}

export async function previewCopy(a: CopyArgs): Promise<OpPreview> {
  const p = await planCopy(a);
  return {
    dryRun: true,
    op: "copy",
    mutates: true,
    message: `copy ${p.before.name} to ${a.toAccount}:${p.toPath.replace(/^[^:]+:/, "")}${p.crossAccount ? " (cross-account)" : ""}${a.trashOriginal ? ", then trash source" : ""}`,
    before: { ...p.before, account: a.fromAccount },
    after: { account: a.toAccount, path: joinPath(p.toPath, p.name), folderId: p.toFolderId },
  };
}

/**
 * Same account: `files.copy`. Different accounts: share the source with the
 * destination account (writer, no e-mail), let the destination copy it
 * server-side, then remove that temporary permission again. No bytes pass
 * through this server. A permission the destination already had is left as is.
 */
export async function copyFile(a: CopyArgs, meta: OpMeta): Promise<CopyResult> {
  const plan = await planCopy(a);
  const { src, dst, file } = plan;
  let copied: DriveFile;
  let tempPermissionId: string | undefined;
  try {
    if (plan.crossAccount) {
      const existing = (await src.drive.listPermissions(file.id)).find((p) => p.emailAddress?.toLowerCase() === dst.ownEmail);
      if (!existing) {
        const perm = await src.drive.createPermission(file.id, { type: "user", role: "writer", emailAddress: dst.ownEmail }, { sendNotificationEmail: false });
        tempPermissionId = perm.id;
      }
    }
    copied = await dst.drive.copy(file.id, { name: plan.name, parents: [plan.toFolderId] });
  } finally {
    if (tempPermissionId) {
      await src.drive.removePermission(file.id, tempPermissionId).catch(() => undefined);
    }
  }
  await appendAudit({
    tool: "copy",
    account: a.fromAccount,
    toAccount: a.toAccount,
    fileId: copied.id,
    name: copied.name,
    from: file.id,
    to: plan.toFolderId,
    owner: ownerLabel(src, file),
    actor: meta.actor,
    batchId: meta.batchId,
  });
  let trashed = false;
  if (a.trashOriginal) {
    await src.drive.setTrashed(file.id, true);
    trashed = true;
    await appendAudit({ tool: "trash", account: a.fromAccount, fileId: file.id, name: file.name, owner: ownerLabel(src, file), actor: meta.actor, batchId: meta.batchId });
  }
  return {
    source: { ...(await toResult(src, file)), trashed },
    copy: await toResult(dst, copied),
    crossAccount: plan.crossAccount,
    note: plan.crossAccount ? `Copied server-side via a temporary writer permission for ${dst.ownEmail} on the source, removed afterwards.` : undefined,
  };
}
