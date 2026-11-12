import { allowedEmails, env, envName, googleClient, googleClientIdProblem, googleClientSecretProblem, resolveBaseUrl, type EnvSource } from "./config";
import { checkProviderToken } from "./providers/tokens";
import {
  accountMail,
  accountMode,
  accountProvider,
  accountScopes,
  getStore,
  gmailGranted,
  loadAccounts,
  refreshAccessTokenFor,
  type Account,
} from "./store";

/** Per-account health for the `status` tool, /connect and /setup. Never returns tokens or secrets. */

export interface TokenHealth {
  ok: boolean;
  error?: string;
  checkedAt: string;
  expiresInSec?: number;
}

export interface AccountStatus {
  label: string;
  email: string;
  provider: "google" | "microsoft" | "dropbox";
  mode: "read" | "write";
  mail: "off" | "draft" | "send";
  scopes: string[];
  connectedAt: string;
  ageDays: number;
  token: TokenHealth;
  gmail: boolean;
  storage: "blob" | "memory";
}

/** Live token check for one provider: resolve with the new access token's lifetime, or throw. */
export type TokenChecker = (account: Account) => Promise<{ expiresInSec?: number }>;

const checkers = new Map<AccountStatus["provider"], TokenChecker>([
  ["google", async (a) => ({ expiresInSec: (await refreshAccessTokenFor(a)).expiresInSec })],
  ["microsoft", checkProviderToken],
  ["dropbox", checkProviderToken],
]);

/** Providers other than Google register their live token check here. */
export function registerTokenChecker(provider: AccountStatus["provider"], fn: TokenChecker) {
  checkers.set(provider, fn);
}

async function checkToken(a: Account): Promise<TokenHealth> {
  const checkedAt = new Date().toISOString();
  const fn = checkers.get(accountProvider(a));
  if (!fn) return { ok: false, error: `no token check available for provider ${accountProvider(a)}`, checkedAt };
  try {
    const { expiresInSec } = await fn(a);
    return expiresInSec === undefined ? { ok: true, checkedAt } : { ok: true, checkedAt, expiresInSec };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const hint = /invalid_grant/.test(msg) ? " (refresh token revoked or expired: reconnect this account on /connect)" : "";
    return { ok: false, error: `${msg}${hint}`, checkedAt };
  }
}

/** Required CROSSDRIVE_ variables (unprefixed key; legacy VAULT_ accepted) and required unprefixed ones. */
const REQUIRED_PREFIXED = ["BASE_URL", "JWT_SECRET", "ENC_KEY", "ALLOWED_EMAILS"] as const;
/** BASE_URL counts as set when Vercel supplies the production domain. */
function isSet(k: (typeof REQUIRED_PREFIXED)[number], src: EnvSource): boolean {
  return k === "BASE_URL" ? resolveBaseUrl(src).source !== "default" : env(k, src) !== undefined;
}
const REQUIRED_PLAIN = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;

/** Configuration warnings that need no request: missing env, memory store, base URL vs the Vercel production host. */
export function configWarnings(src: EnvSource = process.env): string[] {
  const w: string[] = [];
  const missing = [...REQUIRED_PREFIXED.filter((k) => !isSet(k, src)).map(envName), ...REQUIRED_PLAIN.filter((k) => !src[k])];
  if (missing.length) w.push(`Missing environment variables: ${missing.join(", ")}.`);
  const idProblem = googleClientIdProblem(src.GOOGLE_CLIENT_ID);
  if (idProblem) w.push(`GOOGLE_CLIENT_ID: ${idProblem}`);
  const secretProblem = src.GOOGLE_CLIENT_SECRET ? googleClientSecretProblem(src.GOOGLE_CLIENT_SECRET) : null;
  if (secretProblem) w.push(`GOOGLE_CLIENT_SECRET: ${secretProblem}`);
  if (!src.BLOB_READ_WRITE_TOKEN) {
    w.push("BLOB_READ_WRITE_TOKEN is not set: using in-memory storage; connected accounts and the audit log are lost on restart.");
  }
  const prod = src.VERCEL_PROJECT_PRODUCTION_URL;
  const base = env("BASE_URL", src);
  // Only an explicit value can disagree; without one the base URL is the production domain itself.
  if (base && prod && src.VERCEL_ENV === "production") {
    const w2 = baseUrlMismatch(base, `https://${prod}`);
    if (w2) w.push(w2);
  }
  return w;
}

/** Warning text when CROSSDRIVE_BASE_URL is not the origin the request (or Vercel) uses; OAuth redirects would break. */
export function baseUrlMismatch(base: string, requestOrigin: string): string | null {
  let b: URL;
  let r: URL;
  try {
    b = new URL(base);
    r = new URL(requestOrigin);
  } catch {
    return `${envName("BASE_URL")} is "${base}", which is not a valid URL. It must be this deployment's own address, not the GitHub repository URL.`;
  }
  if (b.host === r.host) return null;
  return (
    `${envName("BASE_URL")} is "${base}": its host (${b.host}) differs from the host serving this request (${r.host}). ` +
    `It must be this deployment's own address (such as ${r.origin}), not the GitHub repository URL; otherwise OAuth redirect URIs and the token issuer will not match.`
  );
}

function ageDays(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86_400_000)) : 0;
}

/** Warning when nothing is connected; /connect itself leaves it out (it lists "None yet." where the accounts go). */
export const NO_ACCOUNTS_WARNING = "No accounts connected yet: open /connect.";

export async function accountStatus(label?: string): Promise<{ accounts: AccountStatus[]; warnings: string[] }> {
  const warnings = configWarnings();
  const storage = getStore().kind;
  if (googleClient() === null && !warnings.some((w) => w.includes("GOOGLE_CLIENT_ID"))) warnings.push("Google OAuth client is not configured.");
  if (allowedEmails().length === 0 && !warnings.some((w) => w.includes(envName("ALLOWED_EMAILS")))) {
    warnings.push(`${envName("ALLOWED_EMAILS")} is empty: nobody can sign in.`);
  }

  let list: Account[];
  try {
    list = await loadAccounts(true);
  } catch (e) {
    warnings.push(`Could not load accounts: ${e instanceof Error ? e.message : String(e)}`);
    return { accounts: [], warnings };
  }
  if (label !== undefined) {
    const all = list;
    list = all.filter((a) => a.label === label);
    if (list.length === 0) {
      const have = all.map((a) => a.label).join(", ") || "none";
      throw new Error(`No connected account labelled "${label}" (connected: ${have}).`);
    }
  } else if (list.length === 0) {
    warnings.push(NO_ACCOUNTS_WARNING);
  }

  const accounts = await Promise.all(
    list.map(async (a): Promise<AccountStatus> => {
      const token = await checkToken(a);
      return {
        label: a.label,
        email: a.email,
        provider: accountProvider(a),
        mode: accountMode(a),
        mail: accountMail(a),
        scopes: accountScopes(a),
        connectedAt: a.connectedAt,
        ageDays: ageDays(a.connectedAt),
        token,
        gmail: accountProvider(a) === "google" && gmailGranted(a),
        storage,
      };
    }),
  );
  for (const a of accounts) if (!a.token.ok) warnings.push(`${a.label}: token check failed: ${a.token.error ?? "unknown error"}`);
  return { accounts, warnings };
}
