import { appendAudit } from "./audit";
import { revokeGoogleToken } from "./google";
import { revokeDropboxToken, revokeMicrosoftToken } from "./providers/tokens";
import { accountProvider, loadAccounts, removeAccount, updateAccount, type Account } from "./store";

/**
 * Owner actions from /connect: change mode / mail, disconnect one account, disconnect everything. Every action is
 * written to the audit log with the admin's e-mail as actor.
 */

export type Provider = ReturnType<typeof accountProvider>;
export type Revoker = (refreshToken: string) => Promise<boolean>;

const revokers = new Map<Provider, Revoker>([
  ["google", (t) => revokeGoogleToken(t, revokeFetch ?? fetch)],
  ["microsoft", () => revokeMicrosoftToken()],
  ["dropbox", (t) => revokeDropboxToken(t)],
]);
let revokeFetch: typeof fetch | undefined;

/** Providers other than Google register their token revocation here. */
export function registerRevoker(provider: Provider, fn: Revoker) {
  revokers.set(provider, fn);
}

/** Test seam: the fetch used for Google's revoke endpoint. */
export function setRevokeFetch(f: typeof fetch | undefined) {
  revokeFetch = f;
}

/**
 * The record to store after a successful provider consent. New accounts default to mode "write" and mail "draft"
 * (mail "off" for providers without mail). A reconnect keeps the label's mode, and for Google its mail, exactly as they
 * were, including a legacy record's absent mail field; OneDrive and Dropbox records always get mail "off".
 */
export function connectedAccountRecord(
  fresh: { label: string; email: string; refresh_token: string; scopes: string[]; provider: Provider },
  existing: Account | undefined,
  now = new Date(),
): Account {
  const base: Account = { ...fresh, connectedAt: now.toISOString() };
  if (existing) {
    if (existing.mode !== undefined) base.mode = existing.mode;
    if (fresh.provider !== "google") base.mail = "off";
    else if (existing.mail !== undefined) base.mail = existing.mail;
    return base;
  }
  return { ...base, mode: "write", mail: fresh.provider === "google" ? "draft" : "off" };
}

export const MODES = ["read", "write"] as const;
export const MAIL_MODES = ["off", "draft", "send"] as const;

export async function setAccountMode(label: string, mode: string, actor: string): Promise<Account> {
  if (!(MODES as readonly string[]).includes(mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
  const a = await updateAccount(label, { mode: mode as Account["mode"] });
  await appendAudit({ tool: "admin_mode", account: label, actor, note: `mode=${mode}` });
  return a;
}

export async function setAccountMail(label: string, mail: string, actor: string): Promise<Account> {
  if (!(MAIL_MODES as readonly string[]).includes(mail)) throw new Error(`mail must be one of ${MAIL_MODES.join(", ")}`);
  const cur = (await loadAccounts(true)).find((a) => a.label === label);
  if (!cur) throw new Error(`No connected account labelled "${label}"`);
  if (mail !== "off" && accountProvider(cur) !== "google") throw new Error(`Mail is only available for Google accounts.`);
  const a = await updateAccount(label, { mail: mail as Account["mail"] });
  await appendAudit({ tool: "admin_mail", account: label, actor, note: `mail=${mail}` });
  return a;
}

export interface DisconnectResult {
  label: string;
  email: string;
  /** true: the provider confirmed revocation; false: it failed (the account is removed anyway); "shared": kept because another label uses the same grant. */
  revoked: boolean | "shared";
}

async function revokeFor(account: Account, remaining: Account[]): Promise<DisconnectResult["revoked"]> {
  const provider = accountProvider(account);
  // A Google refresh-token revoke ends the whole grant for that Google account, so keep it while another label uses it.
  const shared = remaining.some((o) => accountProvider(o) === provider && o.email.toLowerCase() === account.email.toLowerCase());
  if (shared) return "shared";
  const fn = revokers.get(provider);
  if (!fn) return false;
  try {
    return await fn(account.refresh_token);
  } catch {
    return false;
  }
}

/** Revoke (best effort) then remove one account. */
export async function disconnectAccount(label: string, actor: string): Promise<DisconnectResult> {
  const accounts = await loadAccounts(true);
  const account = accounts.find((a) => a.label === label);
  if (!account) throw new Error(`No connected account labelled "${label}"`);
  const revoked = await revokeFor(
    account,
    accounts.filter((a) => a.label !== label),
  );
  await removeAccount(label);
  await appendAudit({ tool: "admin_disconnect", account: label, actor, email: account.email, note: `revoked=${revoked}` });
  return { label, email: account.email, revoked };
}

/** Kill switch: revoke and remove every connected account. */
export async function disconnectAll(actor: string): Promise<DisconnectResult[]> {
  const accounts = await loadAccounts(true);
  const out: DisconnectResult[] = [];
  const seen = new Set<string>();
  for (const a of accounts) {
    const key = `${accountProvider(a)}:${a.email.toLowerCase()}`;
    // Every label goes, so each grant is revoked exactly once.
    const revoked = seen.has(key) ? "shared" : await revokeFor(a, []);
    seen.add(key);
    await removeAccount(a.label);
    await appendAudit({ tool: "admin_disconnect", account: a.label, actor, email: a.email, note: `kill switch; revoked=${revoked}` });
    out.push({ label: a.label, email: a.email, revoked });
  }
  return out;
}
