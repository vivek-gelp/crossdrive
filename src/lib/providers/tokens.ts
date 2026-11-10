/**
 * OAuth for Microsoft (identity platform v2.0, delegated, Graph scopes) and
 * Dropbox (scoped app, `token_access_type=offline`): consent URLs, code
 * exchange and refresh, with access tokens cached in memory per label like
 * the Google path in store.ts. Google accounts are delegated to store.ts.
 *
 * Microsoft rotates refresh tokens: when a refresh answers with a new one we
 * persist it (best effort; the previous token stays valid until it expires).
 */
import { baseUrl } from "../config";
import { accessTokenFor as googleAccessToken, accountProvider, upsertAccount, type Account } from "../store";
import { currentProviderFetch, dropboxClient, microsoftClient } from "./env";
import { ProviderError } from "./types";

export const MS_SCOPES = ["offline_access", "Files.ReadWrite.All", "User.Read"] as const;
export const DROPBOX_AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
export const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

export function msAuthority(): string {
  const c = requireMs();
  return `https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0`;
}

export function microsoftRedirectUri(): string {
  return `${baseUrl()}/connect/microsoft/callback`;
}

export function dropboxRedirectUri(): string {
  return `${baseUrl()}/connect/dropbox/callback`;
}

function requireMs() {
  const c = microsoftClient();
  if (!c) throw new Error("Microsoft OAuth client is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET)");
  return c;
}

function requireDropbox() {
  const c = dropboxClient();
  if (!c) throw new Error("Dropbox OAuth client is not configured (DROPBOX_CLIENT_ID / DROPBOX_CLIENT_SECRET)");
  return c;
}

export function microsoftConsentUrl(state: string, codeChallenge: string, loginHint?: string): string {
  const { clientId } = requireMs();
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: microsoftRedirectUri(),
    response_mode: "query",
    scope: MS_SCOPES.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  if (loginHint) q.set("login_hint", loginHint);
  return `${msAuthority()}/authorize?${q}`;
}

/** Scopes are whatever the Dropbox app has enabled in its Permissions tab (none requested explicitly, see docs/providers.md). */
export function dropboxConsentUrl(state: string, codeChallenge: string): string {
  const { clientId } = requireDropbox();
  const q = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: dropboxRedirectUri(),
    token_access_type: "offline",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `${DROPBOX_AUTHORIZE_URL}?${q}`;
}

export interface ProviderTokens {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

async function tokenRequest(url: string, body: Record<string, string>, what: string): Promise<ProviderTokens> {
  const res = await currentProviderFetch()(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { error?: string; error_description?: string };
      detail = j.error ?? "";
    } catch {
      /* ignore */
    }
    throw new ProviderError(`${what} failed (${res.status}${detail ? `: ${detail}` : ""})`, res.status, detail || undefined);
  }
  const t = (await res.json()) as ProviderTokens;
  if (!t.access_token) throw new Error(`${what} returned no access token`);
  return t;
}

export function exchangeMicrosoftCode(code: string, codeVerifier: string): Promise<ProviderTokens> {
  const { clientId, clientSecret } = requireMs();
  return tokenRequest(
    `${msAuthority()}/token`,
    {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: microsoftRedirectUri(),
      code_verifier: codeVerifier,
      scope: MS_SCOPES.join(" "),
    },
    "Microsoft token exchange",
  );
}

export function exchangeDropboxCode(code: string, codeVerifier: string): Promise<ProviderTokens> {
  const { clientId, clientSecret } = requireDropbox();
  return tokenRequest(
    DROPBOX_TOKEN_URL,
    { client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", code, redirect_uri: dropboxRedirectUri(), code_verifier: codeVerifier },
    "Dropbox token exchange",
  );
}

function refreshMicrosoft(refreshToken: string): Promise<ProviderTokens> {
  const { clientId, clientSecret } = requireMs();
  return tokenRequest(
    `${msAuthority()}/token`,
    { client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken, scope: MS_SCOPES.join(" ") },
    "Microsoft token refresh",
  );
}

function refreshDropbox(refreshToken: string): Promise<ProviderTokens> {
  const { clientId, clientSecret } = requireDropbox();
  return tokenRequest(DROPBOX_TOKEN_URL, { client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }, "Dropbox token refresh");
}

// ---- access-token cache (memory only) ---------------------------------------

const cache = new Map<string, { token: string; exp: number }>();

/** Forget cached tokens (tests, reconnects). */
export function clearProviderTokens(label?: string) {
  if (!label) return cache.clear();
  for (const k of [...cache.keys()]) if (k.endsWith(`:${label}`)) cache.delete(k);
}

/** Always refreshes a OneDrive / Dropbox access token (proves the refresh token still works), caches it and persists a rotated refresh token. */
export async function refreshProviderToken(account: Account): Promise<{ token: string; expiresInSec: number }> {
  const provider = accountProvider(account);
  if (provider === "google") throw new Error("refreshProviderToken is for OneDrive and Dropbox accounts");
  const t = provider === "microsoft" ? await refreshMicrosoft(account.refresh_token) : await refreshDropbox(account.refresh_token);
  const expiresInSec = t.expires_in || 3600;
  cache.set(`${provider}:${account.label}`, { token: t.access_token, exp: Date.now() + expiresInSec * 1000 });
  if (provider === "microsoft" && t.refresh_token && t.refresh_token !== account.refresh_token) {
    await upsertAccount({ ...account, refresh_token: t.refresh_token }).catch(() => undefined);
  }
  return { token: t.access_token, expiresInSec };
}

/** A valid access token for any connected account; refreshes when within a minute of expiry. */
export async function providerAccessToken(account: Account): Promise<string> {
  const provider = accountProvider(account);
  if (provider === "google") return googleAccessToken(account);
  const hit = cache.get(`${provider}:${account.label}`);
  if (hit && hit.exp - 60_000 > Date.now()) return hit.token;
  return (await refreshProviderToken(account)).token;
}

/** Live token check for the `status` tool and /connect (registered in status.ts). */
export async function checkProviderToken(account: Account): Promise<{ expiresInSec?: number }> {
  return { expiresInSec: (await refreshProviderToken(account)).expiresInSec };
}

export const DROPBOX_REVOKE_URL = "https://api.dropboxapi.com/2/auth/token/revoke";

/**
 * Dropbox: revoking an access token that came from a refresh token also disables that refresh token. Resolves true
 * when Dropbox confirms.
 */
export async function revokeDropboxToken(refreshToken: string): Promise<boolean> {
  const t = await refreshDropbox(refreshToken);
  const res = await currentProviderFetch()(DROPBOX_REVOKE_URL, { method: "POST", headers: { Authorization: `Bearer ${t.access_token}` } });
  return res.ok;
}

/**
 * Microsoft identity platform has no endpoint that revokes a single delegated refresh token, so disconnecting a
 * OneDrive account only deletes the stored token; the owner removes the app's consent in the Microsoft account
 * (account.live.com/consent/Manage, or My Apps for work/school accounts). Always resolves false ("not revoked").
 */
export async function revokeMicrosoftToken(): Promise<boolean> {
  return false;
}
