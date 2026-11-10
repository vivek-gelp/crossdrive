import { env, envName, LEGACY_ENV_PREFIX, type EnvSource } from "./config";
import { baseUrlMismatch } from "./status";

/**
 * First-run checklist for /setup. Public page, so it reports presence (true/false) only: never values, labels or
 * e-mails. `ok: null` marks a reminder that cannot be checked automatically.
 */

export interface SetupCheck {
  id: string;
  title: string;
  ok: boolean | null;
  detail?: string;
}

/**
 * `key` is the unprefixed name for CROSSDRIVE_ variables (read through `env()`, legacy VAULT_ accepted) and the full
 * name otherwise. Check ids keep the pre-rename `env:VAULT_<key>` form so they stay stable.
 */
export const ENV_VARS: { key: string; prefixed: boolean; why: string; optional?: boolean }[] = [
  { key: "BASE_URL", prefixed: true, why: "public https URL of this deployment, no trailing slash" },
  { key: "JWT_SECRET", prefixed: true, why: "32+ random bytes, base64; signs every OAuth artefact" },
  { key: "ENC_KEY", prefixed: true, why: "exactly 32 random bytes, base64; encrypts stored refresh tokens" },
  { key: "ALLOWED_EMAILS", prefixed: true, why: "comma-separated Google e-mails allowed to sign in" },
  { key: "GOOGLE_CLIENT_ID", prefixed: false, why: "Google OAuth web client" },
  { key: "GOOGLE_CLIENT_SECRET", prefixed: false, why: "Google OAuth web client" },
  { key: "BLOB_READ_WRITE_TOKEN", prefixed: false, why: "set by attaching a private Vercel Blob store" },
  { key: "STATIC_TOKENS", prefixed: true, why: "optional full-access bearer tokens for clients without OAuth", optional: true },
  { key: "READONLY_TOKENS", prefixed: true, why: "optional read-only bearer tokens", optional: true },
];

function decodedLength(b64: string | undefined): number {
  return b64 ? Buffer.from(b64, "base64").length : 0;
}

export function googleRedirectUris(base: string): string[] {
  const b = base.replace(/\/$/, "");
  return [`${b}/oauth/google-callback`, `${b}/api/google/callback`];
}

export function setupChecks(opts: { env: EnvSource; requestOrigin: string; accounts: number | null }): SetupCheck[] {
  const src = opts.env;
  const out: SetupCheck[] = [];
  for (const v of ENV_VARS) {
    const present = v.prefixed ? env(v.key, src) !== undefined : !!src[v.key];
    const name = v.prefixed ? envName(v.key) : v.key;
    out.push({
      id: `env:${v.prefixed ? LEGACY_ENV_PREFIX + v.key : v.key}`,
      title: `${name} is set`,
      ok: v.optional && !present ? null : present,
      detail: v.optional ? `Optional: ${v.why}` : v.why,
    });
  }
  const jwt = env("JWT_SECRET", src);
  if (jwt) out.push({ id: "jwt-length", title: `${envName("JWT_SECRET")} decodes to at least 32 bytes`, ok: decodedLength(jwt) >= 32 });
  const enc = env("ENC_KEY", src);
  if (enc) out.push({ id: "enc-length", title: `${envName("ENC_KEY")} decodes to exactly 32 bytes`, ok: decodedLength(enc) === 32 });
  out.push({ id: "blob", title: "Blob store attached (accounts persist)", ok: !!src.BLOB_READ_WRITE_TOKEN });
  out.push({ id: "google", title: "Google OAuth client configured", ok: !!src.GOOGLE_CLIENT_ID && !!src.GOOGLE_CLIENT_SECRET });
  const base = env("BASE_URL", src);
  const mismatch = base ? baseUrlMismatch(base, opts.requestOrigin) : `${envName("BASE_URL")} is not set.`;
  out.push({ id: "base-url", title: `${envName("BASE_URL")} matches the address you opened this page on`, ok: mismatch === null, detail: mismatch ?? undefined });
  const allowed = (env("ALLOWED_EMAILS", src) ?? "").split(",").filter((s) => s.trim()).length;
  out.push({ id: "allowed", title: "At least one allowed sign-in e-mail", ok: allowed > 0 });
  out.push({
    id: "accounts",
    title: "At least one account connected (on /connect)",
    ok: opts.accounts === null ? false : opts.accounts > 0,
    detail: opts.accounts === null ? "Could not read the account store." : undefined,
  });
  out.push({
    id: "publish",
    title: "Google OAuth consent screen is published to Production (or Internal for a Workspace-only setup)",
    ok: null,
    detail: "In Testing mode Google expires refresh tokens after 7 days and every account has to be reconnected.",
  });
  out.push({
    id: "redirects",
    title: "Both redirect URIs below are listed under the OAuth client's Authorized redirect URIs",
    ok: null,
  });
  return out;
}
