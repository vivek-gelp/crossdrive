/**
 * Per-account request context and the result/guard helpers shared by every
 * tool and by the lib modules (ops, batch, permissions, duplicates, changes).
 */
import { env } from "./config";
import { DriveClient, FOLDER_MIME, type DriveFile, type FetchLike } from "./drive";
import { isGoogleNativeMime, namingRuleEnabled, validateName } from "./naming";
import { assertGoogleAccount } from "./providers/guards";
import { parsePathArg, pathResolver, resolveDrivePath, resolvePath, resolveSharedPath } from "./paths";
import { accessTokenFor, getAccount, type Account } from "./store";

/** Folder in each My Drive root that receives uploads without a target: CROSSDRIVE_INBOX_FOLDER, default "Inbox". */
export function inboxFolder(): string {
  const v = (env("INBOX_FOLDER") ?? "").trim();
  return v && !/[/\\]/.test(v) ? v : "Inbox";
}

/** Per-label My Drive root id and the account's own email (from `about`), cached for the process lifetime. */
const driveIdentity = new Map<string, { rootId: string; ownEmail: string }>();

let driveFetch: FetchLike | undefined;

/** Test seam: route every DriveClient through this fetch (and forget cached identities). */
export function setDriveFetch(f: FetchLike | undefined) {
  driveFetch = f;
  driveIdentity.clear();
}

export function currentDriveFetch(): FetchLike {
  return driveFetch ?? fetch;
}

export interface Ctx {
  account: Account;
  drive: DriveClient;
  rootId: string;
  /** Lower-cased email of the connected account, used to tell own items from shared ones. */
  ownEmail: string;
}

export async function ctxFor(label: string): Promise<Ctx> {
  const account = await getAccount(label);
  assertGoogleAccount(account);
  const drive = new DriveClient(await accessTokenFor(account), currentDriveFetch());
  let id = driveIdentity.get(label);
  if (!id) {
    const [rootId, about] = await Promise.all([drive.rootId(), drive.about().catch(() => ({}) as { user?: { emailAddress?: string } })]);
    id = { rootId, ownEmail: (about.user?.emailAddress ?? account.email).toLowerCase() };
    driveIdentity.set(label, id);
  }
  return { account, drive, rootId: id.rootId, ownEmail: id.ownEmail };
}

export interface FileResult {
  account: string;
  id: string;
  name: string;
  mimeType: string;
  /** `label:/A/B/name` (My Drive), `label:~shared/Top/Sub/name` ("Shared with me") or `label:drive/<Drive>/Sub/name` (Shared Drive). */
  path: string;
  /**
   * Owner email; "me" when the connected account owns it; `shared drive "<name>"` for Shared Drive items; "unknown"
   * when Drive withholds the owner of an item shared with the account.
   */
  owner: string;
  /** True when someone else (a person, or a Shared Drive the account is not a member of) owns the item. */
  shared: boolean;
  /** From Drive `capabilities.canEdit`; false means view-only / commenter access. */
  canEdit: boolean;
  modifiedTime?: string;
  size?: number;
  webViewLink?: string;
}

/** Owner email of `f`, lower-cased, or undefined when Drive reports no owners (Shared Drive items). */
export function ownerEmail(f: DriveFile): string | undefined {
  return f.owners?.[0]?.emailAddress?.toLowerCase();
}

/** Owner label used for items that belong to a Shared Drive rather than a person. */
export function sharedDriveOwner(path: string, label: string): string {
  const prefix = `${label}:drive/`;
  const name = path.startsWith(prefix) ? path.slice(prefix.length).split("/")[0] : "";
  return name ? `shared drive "${name}"` : "shared drive";
}

/**
 * Who owns `f`, as seen by the account `ownEmail`. Only positive evidence makes an item "me": `ownedByMe === true`,
 * or an owners[] entry flagged `me` / carrying the account's email. Drive omits `ownedByMe` for Shared Drive items and
 * can omit both it and `owners` for items shared with the account, so a missing field never means "mine".
 * Shared Drive items are owned by the drive; they count as shared unless the path shows the account is a member.
 * `sharedWithMe` (the item came from a `sharedWithMe = true` query) forces `shared: true`.
 */
export function ownership(label: string, ownEmail: string, f: DriveFile, path: string, opts: { sharedWithMe?: boolean } = {}): { owner: string; shared: boolean } {
  const own = ownEmail.toLowerCase();
  const owners = f.owners ?? [];
  const mine = f.ownedByMe === true || (f.ownedByMe !== false && owners.some((o) => o.me === true || o.emailAddress?.toLowerCase() === own));
  if (mine && !opts.sharedWithMe) return { owner: "me", shared: false };
  const other = owners.find((o) => o.emailAddress && o.emailAddress.toLowerCase() !== own)?.emailAddress;
  if (other) return { owner: other, shared: true };
  if (f.driveId) return { owner: sharedDriveOwner(path, label), shared: opts.sharedWithMe === true || !path.startsWith(`${label}:drive/`) };
  return { owner: mine ? "me" : "unknown", shared: true };
}

/** Pure mapping of a Drive file to the result shape every tool returns. */
export function fileResult(label: string, ownEmail: string, f: DriveFile, path: string, opts: { sharedWithMe?: boolean } = {}): FileResult {
  const { owner, shared } = ownership(label, ownEmail, f, path, opts);
  return {
    account: label,
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    path,
    owner,
    shared,
    canEdit: f.capabilities?.canEdit ?? true,
    modifiedTime: f.modifiedTime,
    size: f.size ? Number(f.size) : undefined,
    webViewLink: f.webViewLink,
  };
}

/**
 * Guard for writes: Drive answers a bare 403 when the account only has
 * Viewer/Commenter access. Check `capabilities` first and explain instead.
 * `edit` covers rename/move/trash of the item itself; `addChildren` covers
 * creating or uploading into a folder.
 */
export function assertWritable(f: DriveFile, need: "edit" | "addChildren"): void {
  const caps = f.capabilities;
  if (!caps) return;
  const ok = need === "edit" ? caps.canEdit !== false : caps.canAddChildren !== false && caps.canEdit !== false;
  if (ok) return;
  const owner = f.owners?.[0]?.emailAddress ?? "unknown";
  throw new Error(`view-only: you cannot modify ${f.name} (owner ${owner}). Ask the owner to grant Editor or transfer ownership.`);
}

/** Owner as recorded in the audit log: email, or "me" for the connected account. */
export function ownerLabel(c: Ctx, f: DriveFile): string {
  return fileResult(c.account.label, c.ownEmail, f, "").owner;
}

export async function toResult(c: Ctx, f: DriveFile, pathHint?: string, opts: { sharedWithMe?: boolean } = {}): Promise<FileResult> {
  const path = pathHint
    ? `${pathHint.replace(/\/$/, "")}/${f.name}`
    : await pathResolver.displayPath(c.account.label, c.drive, f.id, c.rootId, f);
  return fileResult(c.account.label, c.ownEmail, f, path, opts);
}

/** Resolve a `label:/a/b`, `label:~shared/Top/b` or `label:drive/<Drive>/b` path for account `c`; label in path must match. */
export async function folderFromPath(c: Ctx, path: string): Promise<string> {
  const parsed = parsePathArg(path);
  if (parsed.label && parsed.label !== c.account.label) {
    throw new Error(`Path label "${parsed.label}" does not match account "${c.account.label}"`);
  }
  return pathResolver.resolve(c.account.label, c.drive, parsed.segments, c.rootId, parsed.shared, parsed.drive);
}

/** Destination folder from `toFolderId`, else `toPath`, else `fallbackPath` (when given). */
export async function targetFolder(c: Ctx, a: { toPath?: string; toFolderId?: string }, fallbackPath?: string): Promise<string> {
  if (a.toFolderId) return a.toFolderId;
  const path = a.toPath ?? fallbackPath;
  if (path === undefined) throw new Error("Give toPath or toFolderId");
  return folderFromPath(c, path);
}

export async function findInbox(drive: DriveClient, rootId = "root"): Promise<string | undefined> {
  const name = inboxFolder();
  const page = await drive.listChildren(rootId);
  return page.files.find((f) => f.mimeType === FOLDER_MIME && f.name === name)?.id;
}

export async function ensureInbox(drive: DriveClient, rootId = "root"): Promise<string> {
  const hit = await findInbox(drive, rootId);
  if (hit) return hit;
  const created = await drive.createFolder(inboxFolder(), rootId);
  return created.id;
}

/**
 * Target folder for a dry run of `put`: like resolvePutTarget but never
 * creates the inbox; `folderId` is undefined when the inbox would be created.
 */
export async function previewPutTarget(drive: DriveClient, args: { path?: string; folderId?: string }, rootId = "root"): Promise<{ folderId?: string; createsInbox: boolean }> {
  if (args.folderId || (args.path !== undefined && args.path !== "")) return { folderId: await resolvePutTarget(drive, args, rootId), createsInbox: false };
  const hit = await findInbox(drive, rootId);
  return { folderId: hit, createsInbox: !hit };
}

/** Target folder for `put`: folderId, then path, else the drive's inbox (created if missing). */
export async function resolvePutTarget(drive: DriveClient, args: { path?: string; folderId?: string }, rootId = "root"): Promise<string> {
  if (args.folderId) return args.folderId;
  if (args.path !== undefined && args.path !== "") {
    const parsed = parsePathArg(args.path);
    if (parsed.shared) return resolveSharedPath(drive, parsed.segments);
    if (parsed.drive) return resolveDrivePath(drive, parsed.segments);
    if (parsed.segments.length === 0) return rootId;
    return resolvePath(drive, parsed.segments, rootId);
  }
  return ensureInbox(drive, rootId);
}

/** Applies the optional naming rule (CROSSDRIVE_NAMING_RULE); with the rule off every name passes. */
export function checkName(name: string, mimeType: string | undefined, allow: boolean) {
  if (!namingRuleEnabled() || allow || isGoogleNativeMime(mimeType)) return;
  const r = validateName(name);
  if (!r.ok) throw new Error(r.reason);
}
