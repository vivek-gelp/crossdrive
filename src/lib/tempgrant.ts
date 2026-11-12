/**
 * Temporary read grants for a cross-account Google -> Google copy whose source
 * account is writable (the "share path").
 *
 * The source account gives the destination account `reader` access (never
 * writer, no e-mail) on ONE file, the destination copies it with files.copy,
 * and the grant is removed again in a `finally`. Every grant carries an
 * `expirationTime` TEMP_GRANT_TTL_MS ahead as a safety net (Drive accepts one
 * on user permissions; when Drive refuses it for an account the grant is made
 * without it and the result says so). A folder is never shared: folder copies
 * grant per file as each file is copied, so nothing broader than the file being
 * copied is exposed and nothing lingers when a client abandons a resume cursor.
 *
 * Bookkeeping: each grant and each removal is written to the audit log
 * (`temp_grant`, `temp_grant_removed`, `temp_grant_remove_failed`) and to a
 * small registry in the store (`tempgrants/open/<key>.json` on grant, removed
 * again on removal; a store without delete writes `tempgrants/closed/<key>.json`). `listLeftoverGrants` reports the
 * open ones without a closed twin after checking each against Drive.
 *
 * Read-only source accounts never get here: they are copied by streaming
 * (see streamcopy.ts), so no permission is ever created on them.
 */
import { appendAudit } from "./audit";
import { ctxFor, ownerLabel, type Ctx } from "./ctx";
import { DriveError, type DriveFile, type Permission } from "./drive";
import type { OpMeta } from "./ops";
import { getStore } from "./store";

/** How long a temporary grant may live if its removal fails (Drive removes it on its own then). */
export const TEMP_GRANT_TTL_MS = 4 * 60 * 60 * 1000;
export const TEMP_GRANT_ROLE = "reader";
const OPEN = "tempgrants/open/";
const CLOSED = "tempgrants/closed/";

export interface TempGrant {
  /** Source account label (the account that holds the file and created the permission). */
  account: string;
  /** Destination account label and e-mail (who received access). */
  toAccount: string;
  email: string;
  fileId: string;
  name: string;
  role: typeof TEMP_GRANT_ROLE;
  permissionId: string;
  /** Absent when Drive refused an expiration for this permission. */
  expiresAt?: string;
  createdAt: string;
  tool: string;
}

export type GrantOutcome =
  | { kind: "existing"; role: string }
  | { kind: "granted"; grant: TempGrant; expiryNote?: string };

export interface RemovalOutcome {
  removed: boolean;
  /** Set when the removal failed: loud, actionable text with the permission id. */
  warning?: string;
}

function key(g: Pick<TempGrant, "account" | "fileId" | "permissionId">): string {
  return [g.account, g.fileId, g.permissionId].map((s) => encodeURIComponent(s)).join("~");
}

/** Mark a grant as gone: drop its open record when the store can remove, else write a closed tombstone. */
async function closeRecord(g: TempGrant, extra: Record<string, string>): Promise<void> {
  const store = getStore();
  if (store.remove) await store.remove(`${OPEN}${key(g)}.json`);
  else await store.write(`${CLOSED}${key(g)}.json`, JSON.stringify({ ...g, ...extra }));
}

function isExpiryRefusal(e: unknown): boolean {
  return e instanceof DriveError && (e.status === 400 || e.status === 403) && /expir/i.test(e.message);
}

/**
 * Give the destination account `reader` access to `file`, with an expiry, unless it can already see the file through
 * an explicit permission (that one is left as it is). Audited and registered.
 */
export async function grantTemporaryRead(src: Ctx, dst: Ctx, file: DriveFile, meta: OpMeta & { tool: string }, now = new Date()): Promise<GrantOutcome> {
  const existing = (await src.drive.listPermissions(file.id)).find((p: Permission) => p.emailAddress?.toLowerCase() === dst.ownEmail);
  if (existing) return { kind: "existing", role: existing.role };
  const expiresAt = new Date(now.getTime() + TEMP_GRANT_TTL_MS).toISOString();
  let perm: Permission;
  let expiryNote: string | undefined;
  let expiry: string | undefined = expiresAt;
  try {
    perm = await src.drive.createPermission(file.id, { type: "user", role: TEMP_GRANT_ROLE, emailAddress: dst.ownEmail, expirationTime: expiresAt }, { sendNotificationEmail: false });
  } catch (e) {
    if (!isExpiryRefusal(e)) throw e;
    perm = await src.drive.createPermission(file.id, { type: "user", role: TEMP_GRANT_ROLE, emailAddress: dst.ownEmail }, { sendNotificationEmail: false });
    expiry = undefined;
    expiryNote = `Drive refused an expiration time for this grant (${(e as Error).message}); it was created without one and removed right after the copy.`;
  }
  const grant: TempGrant = {
    account: src.account.label,
    toAccount: dst.account.label,
    email: dst.ownEmail,
    fileId: file.id,
    name: file.name,
    role: TEMP_GRANT_ROLE,
    permissionId: perm.id,
    expiresAt: perm.expirationTime ?? expiry,
    createdAt: now.toISOString(),
    tool: meta.tool,
  };
  await getStore().write(`${OPEN}${key(grant)}.json`, JSON.stringify(grant));
  await appendAudit({
    tool: "temp_grant",
    account: grant.account,
    toAccount: grant.toAccount,
    fileId: file.id,
    name: file.name,
    email: grant.email,
    role: grant.role,
    permissionId: grant.permissionId,
    expiresAt: grant.expiresAt,
    owner: ownerLabel(src, file),
    actor: meta.actor,
    batchId: meta.batchId,
    note: `temporary read access for a cross-account ${meta.tool}${expiryNote ? "; no expiration (refused by Drive)" : ""}`,
  });
  return { kind: "granted", grant, expiryNote };
}

/** How to remove a grant by hand; used in loud warnings. */
export function removalHint(g: TempGrant): string {
  return (
    `remove it with unshare {account:"${g.account}", fileId:"${g.fileId}", email:"${g.email}"} or in Drive's Share dialog of "${g.name}" ` +
    `(permission id ${g.permissionId})${g.expiresAt ? `; Drive removes it on its own at ${g.expiresAt}` : ""}`
  );
}

/** Remove a temporary grant. Never throws: a failure is audited and returned as a loud warning. */
export async function removeTemporaryGrant(src: Ctx, g: TempGrant, meta: OpMeta): Promise<RemovalOutcome> {
  try {
    await src.drive.removePermission(g.fileId, g.permissionId);
  } catch (e) {
    // Already gone (expired, or removed by hand): nothing is left behind.
    if (!(e instanceof DriveError && e.status === 404)) {
      const error = e instanceof Error ? e.message : String(e);
      await appendAudit({
        tool: "temp_grant_remove_failed",
        account: g.account,
        toAccount: g.toAccount,
        fileId: g.fileId,
        name: g.name,
        email: g.email,
        role: g.role,
        permissionId: g.permissionId,
        expiresAt: g.expiresAt,
        actor: meta.actor,
        batchId: meta.batchId,
        note: error,
      }).catch(() => undefined);
      return {
        removed: false,
        warning: `TEMPORARY GRANT NOT REMOVED (permission id ${g.permissionId}): ${g.email} still has ${g.role} access to "${g.name}" (file ${g.fileId}) in account ${g.account} (${error}). Please ${removalHint(g)}. The status tool lists such leftovers.`,
      };
    }
  }
  await closeRecord(g, { removedAt: new Date().toISOString() });
  await appendAudit({
    tool: "temp_grant_removed",
    account: g.account,
    toAccount: g.toAccount,
    fileId: g.fileId,
    name: g.name,
    email: g.email,
    role: g.role,
    permissionId: g.permissionId,
    expiresAt: g.expiresAt,
    actor: meta.actor,
    batchId: meta.batchId,
  });
  return { removed: true };
}

export interface LeftoverGrant extends TempGrant {
  hint: string;
}

export interface LeftoverReport {
  /** Grants created by Crossdrive that Drive still shows. */
  open: LeftoverGrant[];
  /** Registered grants Drive no longer shows (expired or removed by hand); now marked closed. */
  goneOnDrive: number;
  errors: { account: string; error: string }[];
}

/**
 * Temporary grants created by Crossdrive without a recorded removal, each verified against Drive (the source
 * account's permission list of that file). Grants Drive no longer has are marked closed and only counted.
 */
export async function listLeftoverGrants(label?: string): Promise<LeftoverReport> {
  const store = getStore();
  const [open, closed] = await Promise.all([store.listPaths(OPEN), store.listPaths(CLOSED)]);
  const closedKeys = new Set(closed.map((p) => p.slice(CLOSED.length)));
  const pending = open.filter((p) => !closedKeys.has(p.slice(OPEN.length)));
  const grants: TempGrant[] = [];
  for (const p of pending) {
    const text = await store.read(p);
    if (!text) continue;
    try {
      const g = JSON.parse(text) as TempGrant;
      if (!label || g.account === label) grants.push(g);
    } catch {
      /* skip a damaged record */
    }
  }
  const report: LeftoverReport = { open: [], goneOnDrive: 0, errors: [] };
  const byAccount = new Map<string, TempGrant[]>();
  for (const g of grants) byAccount.set(g.account, [...(byAccount.get(g.account) ?? []), g]);
  await Promise.all(
    [...byAccount].map(async ([account, list]) => {
      let c: Ctx;
      try {
        c = await ctxFor(account);
      } catch (e) {
        report.errors.push({ account, error: e instanceof Error ? e.message : String(e) });
        return;
      }
      for (const g of list) {
        let perms: Permission[];
        try {
          perms = await c.drive.listPermissions(g.fileId);
        } catch (e) {
          if (e instanceof DriveError && e.status === 404) perms = [];
          else {
            report.errors.push({ account, error: `${g.fileId}: ${e instanceof Error ? e.message : String(e)}` });
            continue;
          }
        }
        if (perms.some((p) => p.id === g.permissionId)) report.open.push({ ...g, hint: removalHint(g) });
        else {
          report.goneOnDrive++;
          await closeRecord(g, { removedAt: new Date().toISOString(), note: "not on Drive any more (expired or removed elsewhere)" });
        }
      }
    }),
  );
  return report;
}

/** True when `permissionId` on `fileId` of `account` is a registered, not yet removed temporary grant. */
export async function openGrantIds(account: string, fileId: string): Promise<Set<string>> {
  const store = getStore();
  const prefix = `${encodeURIComponent(account)}~${encodeURIComponent(fileId)}~`;
  const [open, closed] = await Promise.all([store.listPaths(`${OPEN}${prefix}`), store.listPaths(`${CLOSED}${prefix}`)]);
  const closedKeys = new Set(closed.map((p) => p.slice(CLOSED.length)));
  return new Set(
    open
      .map((p) => p.slice(OPEN.length))
      .filter((k) => !closedKeys.has(k))
      .map((k) => decodeURIComponent(k.slice(prefix.length).replace(/\.json$/, ""))),
  );
}
