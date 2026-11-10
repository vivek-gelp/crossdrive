import { createRemoteJWKSet, jwtVerify } from "jose";
import { baseUrl, googleClient } from "./config";

/** Google OAuth 2.0 / OIDC helpers: sign-in, Drive + Gmail consent, token refresh. */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
/** Gmail: read/modify (labels, archive, trash), drafts, send. No scope here allows permanent deletion. */
export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
] as const;
const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

/**
 * Short names of the Drive/Gmail scopes in a token response's `scope` field
 * (`drive`, `gmail.modify`, ...), sorted. Identity scopes are dropped. A
 * missing field means the pre-0.4.0 Drive-only grant.
 */
export function parseGrantedScopes(scopeField: string | undefined): string[] {
  const out = new Set<string>();
  for (const s of (scopeField ?? "").split(/\s+/).filter(Boolean)) {
    const short = s.startsWith(SCOPE_PREFIX) ? s.slice(SCOPE_PREFIX.length) : s;
    if (short === "drive" || short.startsWith("gmail.")) out.add(short);
  }
  if (out.size === 0) out.add("drive");
  return [...out].sort();
}

export function loginRedirectUri(): string {
  return `${baseUrl()}/oauth/google-callback`;
}

export function driveRedirectUri(): string {
  return `${baseUrl()}/api/google/callback`;
}

function requireClient() {
  const c = googleClient();
  if (!c) throw new Error("Google OAuth client is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)");
  return c;
}

/** Sign-in URL asking only for identity (openid email). */
export function googleLoginUrl(state: string): string {
  const { clientId } = requireClient();
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: loginRedirectUri(),
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  return `${AUTH_URL}?${q}`;
}

/**
 * Account consent URL: Drive + Gmail scopes, offline refresh token, forced
 * consent, incremental auth (previously granted scopes are kept). `loginHint`
 * pre-selects the Google account when re-running consent for a known label.
 */
export function googleConsentUrl(state: string, opts: { loginHint?: string } = {}): string {
  const { clientId } = requireClient();
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: driveRedirectUri(),
    response_type: "code",
    scope: `openid email ${DRIVE_SCOPE} ${GMAIL_SCOPES.join(" ")}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  if (opts.loginHint) q.set("login_hint", opts.loginHint);
  return `${AUTH_URL}?${q}`;
}

export interface GoogleTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

export async function exchangeCode(code: string, redirectUri: string, fetchImpl: typeof fetch = fetch): Promise<GoogleTokens> {
  const { clientId, clientSecret } = requireClient();
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
  return (await res.json()) as GoogleTokens;
}

export async function refreshAccessToken(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<GoogleTokens> {
  const { clientId, clientSecret } = requireClient();
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed (${res.status}${await googleErrorCode(res)})`);
  return (await res.json()) as GoogleTokens;
}

/** Verify a Google ID token and return the (verified) email. */
export async function verifyGoogleIdToken(idToken: string): Promise<{ email: string; sub: string }> {
  const { clientId } = requireClient();
  const { payload } = await jwtVerify(idToken, JWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
  });
  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
  if (!email || payload.email_verified === false) throw new Error("Google ID token has no verified email");
  return { email, sub: String(payload.sub) };
}

/** ": invalid_grant" style suffix from a Google OAuth error body (never echoes tokens). */
async function googleErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? `: ${body.error}` : "";
  } catch {
    return "";
  }
}

/**
 * Revoke a Google refresh (or access) token. Revoking a refresh token ends the whole grant for this OAuth client and
 * that Google account. Best-effort: returns false instead of throwing; an already-invalid token counts as revoked.
 */
export async function revokeGoogleToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (res.ok) return true;
    return (await googleErrorCode(res)) === ": invalid_token";
  } catch {
    return false;
  }
}
