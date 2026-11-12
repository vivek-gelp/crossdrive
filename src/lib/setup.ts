import {
  env,
  envName,
  googleClientIdProblem,
  googleClientProblem,
  googleClientSecretHasPrefix,
  googleClientSecretProblem,
  LEGACY_ENV_PREFIX,
  resolveBaseUrl,
  type EnvSource,
} from "./config";
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
  { key: "BASE_URL", prefixed: true, why: "public https URL of this deployment, no trailing slash (on Vercel it defaults to the production domain)" },
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

export const VERCEL_BASE_URL_NOTE = `taken from Vercel (set ${envName("BASE_URL")} to use a custom domain)`;

/** Shape checks for the Google client variables: never prints the values. */
function googleEnvCheck(key: string, value: string | undefined, why: string): Pick<SetupCheck, "ok" | "detail"> {
  if (!value) return { ok: false, detail: why };
  if (key === "GOOGLE_CLIENT_ID") {
    const p = googleClientIdProblem(value);
    return p ? { ok: false, detail: p } : { ok: true, detail: why };
  }
  const p = googleClientSecretProblem(value);
  if (p) return { ok: false, detail: p };
  if (!googleClientSecretHasPrefix(value)) {
    return {
      ok: null,
      detail: "Does not start with GOCSPX- like current Google client secrets. Older clients can differ; if Google answers invalid_client, copy the secret again.",
    };
  }
  return { ok: true, detail: why };
}

export function setupChecks(opts: { env: EnvSource; requestOrigin: string; accounts: number | null }): SetupCheck[] {
  const src = opts.env;
  const out: SetupCheck[] = [];
  const resolved = resolveBaseUrl(src);
  for (const v of ENV_VARS) {
    const present = v.prefixed ? env(v.key, src) !== undefined : !!src[v.key];
    const name = v.prefixed ? envName(v.key) : v.key;
    const id = `env:${v.prefixed ? LEGACY_ENV_PREFIX + v.key : v.key}`;
    if (v.key === "BASE_URL" && resolved.source === "vercel") {
      out.push({ id, title: `${name} is ${VERCEL_BASE_URL_NOTE}`, ok: true, detail: resolved.url });
      continue;
    }
    if (v.key === "GOOGLE_CLIENT_ID" || v.key === "GOOGLE_CLIENT_SECRET") {
      out.push({ id, title: `${name} is set`, ...googleEnvCheck(v.key, src[v.key], v.why) });
      continue;
    }
    out.push({
      id,
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
  out.push({ id: "google", title: "Google OAuth client configured", ok: googleClientProblem(src) === null });
  const baseTitle = `${envName("BASE_URL")} matches the address you opened this page on`;
  if (resolved.source === "default") {
    out.push({ id: "base-url", title: baseTitle, ok: false, detail: `${envName("BASE_URL")} is not set.` });
  } else if (resolved.source === "env") {
    const mismatch = baseUrlMismatch(resolved.url, opts.requestOrigin);
    out.push({ id: "base-url", title: baseTitle, ok: mismatch === null, detail: mismatch ?? undefined });
  } else {
    // Vercel's production domain is right for OAuth even when this page was opened on a preview or deployment URL.
    const same = baseUrlMismatch(resolved.url, opts.requestOrigin) === null;
    out.push({
      id: "base-url",
      title: baseTitle,
      ok: same ? true : null,
      detail: same
        ? `${resolved.url}, ${VERCEL_BASE_URL_NOTE}`
        : `${resolved.url}, ${VERCEL_BASE_URL_NOTE}. You opened this page on another address; sign-in and MCP clients must use ${resolved.url}.`,
    });
  }
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
