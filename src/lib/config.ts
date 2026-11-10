import type { JwtEnv } from "./jwt";

export const VERSION = "1.0.0";

/**
 * Account labels are chosen by the owner when connecting an account: a lower-case letter, then up to 23 lower-case
 * letters, digits or hyphens (`personal`, `work`, `client-a`). They prefix every path (`work:/Projects`).
 */
export const LABEL_RE = /^[a-z][a-z0-9-]{0,23}$/;
export type AccountLabel = string;

export function isValidLabel(s: unknown): s is AccountLabel {
  return typeof s === "string" && LABEL_RE.test(s);
}

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- environment ------------------------------------------------------------

/** Prefix of every Crossdrive variable. */
export const ENV_PREFIX = "CROSSDRIVE_";
/** Prefix used before the rename; still read as a fallback so existing deployments keep working. */
export const LEGACY_ENV_PREFIX = "VAULT_";

export type EnvSource = Record<string, string | undefined>;

/**
 * Value of `CROSSDRIVE_<name>`, else of the legacy `VAULT_<name>`, else undefined. An empty string counts as unset.
 * `name` is given without prefix: `env("JWT_SECRET")`. Unprefixed variables (GOOGLE_CLIENT_ID, MS_*, DROPBOX_*,
 * BLOB_READ_WRITE_TOKEN) are read directly, not through this helper.
 */
export function env(name: string, source: EnvSource = process.env): string | undefined {
  for (const key of [ENV_PREFIX + name, LEGACY_ENV_PREFIX + name]) {
    const v = source[key];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/** The documented variable name for messages and the setup page: `envName("JWT_SECRET")` is `CROSSDRIVE_JWT_SECRET`. */
export function envName(name: string): string {
  return ENV_PREFIX + name;
}

export function baseUrl(): string {
  return (env("BASE_URL") ?? "http://localhost:3000").replace(/\/$/, "");
}

export function jwtEnv(): JwtEnv {
  const secret = env("JWT_SECRET");
  if (!secret) throw new Error(`${envName("JWT_SECRET")} is not set`);
  return { secret, issuer: baseUrl() };
}

export function encKey(): string {
  const k = env("ENC_KEY");
  if (!k) throw new Error(`${envName("ENC_KEY")} is not set`);
  return k;
}

export function allowedEmails(): string[] {
  return list(env("ALLOWED_EMAILS")).map((e) => e.toLowerCase());
}

export function staticTokens(): string[] {
  return list(env("STATIC_TOKENS"));
}

export function readonlyTokens(): string[] {
  return list(env("READONLY_TOKENS"));
}

export function googleClient(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isAllowedEmail(email: string | undefined): boolean {
  return !!email && allowedEmails().includes(email.toLowerCase());
}

/** Optional providers: their connect buttons only appear when the client id is configured. */
export function microsoftConfigured(): boolean {
  return !!process.env.MS_CLIENT_ID;
}

export function dropboxConfigured(): boolean {
  return !!process.env.DROPBOX_CLIENT_ID;
}
