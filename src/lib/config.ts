import type { JwtEnv } from "./jwt";

export const VERSION = "1.0.1";

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

export type BaseUrlSource = "env" | "vercel" | "default";

/**
 * Public URL of this deployment and where it came from: an explicit CROSSDRIVE_BASE_URL (legacy VAULT_ accepted)
 * wins; else Vercel's system variable VERCEL_PROJECT_PRODUCTION_URL (a bare host, so https:// is added); else
 * http://localhost:3000. No trailing slash.
 */
export function resolveBaseUrl(source: EnvSource = process.env): { url: string; source: BaseUrlSource } {
  const explicit = env("BASE_URL", source);
  if (explicit) return { url: explicit.replace(/\/$/, ""), source: "env" };
  const vercel = source.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) {
    const url = /^https?:\/\//i.test(vercel) ? vercel : `https://${vercel}`;
    return { url: url.replace(/\/$/, ""), source: "vercel" };
  }
  return { url: "http://localhost:3000", source: "default" };
}

export function baseUrl(): string {
  return resolveBaseUrl().url;
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

// ---- Google client shape checks ----------------------------------------------
// Never echo the values: these messages appear on the public /setup page.

const PLACEHOLDER_RE = /paste|your_|changeme|<|xxx/i;
const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";
const CLIENTS_HINT = "copy it from Google Cloud Console → Google Auth Platform → Clients";

/** Why GOOGLE_CLIENT_ID cannot be a real Google client ID, or null when it looks right (or is unset). */
export function googleClientIdProblem(v: string | undefined): string | null {
  if (!v) return null;
  if (/\s/.test(v) || PLACEHOLDER_RE.test(v) || !v.endsWith(CLIENT_ID_SUFFIX) || v.length === CLIENT_ID_SUFFIX.length) {
    return `This does not look like a Google client ID (it should end in ${CLIENT_ID_SUFFIX}); ${CLIENTS_HINT}.`;
  }
  return null;
}

/** Why GOOGLE_CLIENT_SECRET cannot be a real client secret, or null when it looks plausible (or is unset). */
export function googleClientSecretProblem(v: string | undefined): string | null {
  if (v === undefined) return null;
  if (v.trim() === "") return `The client secret is empty; ${CLIENTS_HINT}.`;
  if (/\s/.test(v)) return `The client secret contains spaces or line breaks; ${CLIENTS_HINT} and paste it again without them.`;
  if (PLACEHOLDER_RE.test(v)) return `This looks like placeholder text, not a Google client secret; ${CLIENTS_HINT}.`;
  return null;
}

/** Current Google client secrets start with GOCSPX-; older ones do not, so a missing prefix is only worth a look. */
export function googleClientSecretHasPrefix(v: string | undefined): boolean {
  return !!v && v.startsWith("GOCSPX-");
}

/**
 * Plain-language reason the Google OAuth client cannot work (unset, or a value that cannot be real), or null when
 * it looks usable. Pages that would otherwise redirect to Google show this instead of a Google error screen.
 */
export function googleClientProblem(source: EnvSource = process.env): string | null {
  const id = source.GOOGLE_CLIENT_ID;
  const secret = source.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) return "The Google OAuth client is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET). Open /setup for the checklist.";
  const p = googleClientIdProblem(id) ? `GOOGLE_CLIENT_ID: ${googleClientIdProblem(id)}` : googleClientSecretProblem(secret) ? `GOOGLE_CLIENT_SECRET: ${googleClientSecretProblem(secret)}` : null;
  return p ? `The Google OAuth client is misconfigured. ${p} Then redeploy and open /setup to check.` : null;
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
