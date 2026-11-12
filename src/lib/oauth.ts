import { OAuthError as McpOAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { timingSafeEqual } from "node:crypto";
import { baseUrl, env, jwtEnv, readonlyTokens, staticTokens } from "./config";
import {
  issueAccessToken,
  issueAuthCode,
  issueClientId,
  issueRefreshToken,
  verifyAccessToken,
  verifyAuthCode,
  verifyClientId,
  verifyPkce,
  verifyRefreshToken,
  type ClientClaims,
} from "./jwt";
import { onceKey, redeemOnce } from "./once";

/**
 * Stateless OAuth 2.1 authorization server pieces (RFC 8414 / 9728 / 7591 /
 * 7636) plus bearer verification for the MCP resource.
 */

export const SCOPE_FULL = "vault";
export const SCOPE_READ = "vault:read";

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(`${code}: ${description}`);
  }
  toJSON() {
    return { error: this.code, error_description: this.description };
  }
}

// ---- metadata --------------------------------------------------------------

export function authorizationServerMetadata() {
  const base = baseUrl();
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    scopes_supported: [SCOPE_FULL],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    service_documentation: `${base}/`,
    // RFC 8414 section 2. Neither RFC 8414 nor RFC 9728 defines a logo field for a server (RFC 7591 logo_uri
    // describes a client), so the logo is advertised by favicon and MCP serverInfo.icons instead.
    op_policy_uri: `${base}/privacy`,
    op_tos_uri: `${base}/terms`,
  };
}

export function protectedResourceMetadata() {
  const base = baseUrl();
  return {
    resource: `${base}/api/mcp`,
    authorization_servers: [base],
    scopes_supported: [SCOPE_FULL],
    bearer_methods_supported: ["header"],
    resource_name: "Crossdrive",
    resource_documentation: `${base}/`,
    // RFC 9728 section 2.
    resource_policy_uri: `${base}/privacy`,
    resource_tos_uri: `${base}/terms`,
  };
}

// ---- dynamic client registration ------------------------------------------

export interface RegistrationRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
  grant_types?: unknown;
}

/** Schemes that are never a valid redirect target, even for native apps. */
const BLOCKED_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:", "mailto:", "tel:", "sms:", "chrome:", "intent:"]);
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const DCR_LIMITS = { redirectUris: 10, uriLength: 2000, clientName: 200 } as const;

export function validateRedirectUri(uri: string): boolean {
  if (uri.length > DCR_LIMITS.uriLength) return false;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.username || u.password) return false;
  if (u.protocol === "https:") return !!u.hostname;
  if (u.protocol === "http:") return LOOPBACK_HOSTS.has(u.hostname);
  // Native-app private-use schemes (cursor://, com.example.app:/cb) are allowed per RFC 8252.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !BLOCKED_SCHEMES.has(u.protocol);
}

/** What the consent screen shows as "where the code goes": host for web, a description for loopback and native apps. */
export function describeRedirect(uri: string): { host: string; kind: "web" | "loopback" | "native" } {
  const u = new URL(uri);
  if (u.protocol === "https:") return { host: u.host, kind: "web" };
  if (u.protocol === "http:") return { host: u.host, kind: "loopback" };
  return { host: u.host ? `${u.protocol}//${u.host}` : u.protocol, kind: "native" };
}

export async function registerClient(body: RegistrationRequest) {
  const uris = body.redirect_uris;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > DCR_LIMITS.redirectUris ||
    !uris.every((u) => typeof u === "string" && validateRedirectUri(u))
  ) {
    throw new OAuthError(
      "invalid_redirect_uri",
      `redirect_uris must be 1-${DCR_LIMITS.redirectUris} https, loopback http or native-app URIs (max ${DCR_LIMITS.uriLength} chars, no fragment)`,
    );
  }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    throw new OAuthError("invalid_client_metadata", "only public clients (token_endpoint_auth_method=none) are supported");
  }
  const client_name =
    typeof body.client_name === "string"
      ? body.client_name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, DCR_LIMITS.clientName) || undefined
      : undefined;
  const client_id = await issueClientId(jwtEnv(), { redirect_uris: [...new Set(uris as string[])], client_name });
  return {
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name,
    redirect_uris: uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SCOPE_FULL,
  };
}

// ---- authorize -------------------------------------------------------------

export interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  scope?: string;
}

/** Validate /oauth/authorize query params. Throws OAuthError on failure. */
export async function validateAuthorizeRequest(params: URLSearchParams): Promise<AuthorizeRequest & { client: ClientClaims }> {
  const client_id = params.get("client_id") ?? "";
  const redirect_uri = params.get("redirect_uri") ?? "";
  if (!client_id) throw new OAuthError("invalid_request", "client_id is required");
  let client: ClientClaims;
  try {
    client = await verifyClientId(jwtEnv(), client_id);
  } catch {
    throw new OAuthError("invalid_client", "unknown client_id", 401);
  }
  if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
    throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
  }
  if (params.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "response_type must be code");
  if (params.get("code_challenge_method") !== "S256") throw new OAuthError("invalid_request", "code_challenge_method must be S256");
  const code_challenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9\-_]{43}$/.test(code_challenge)) throw new OAuthError("invalid_request", "code_challenge must be a base64url SHA-256");
  const scopes = (params.get("scope") ?? SCOPE_FULL).split(/\s+/).filter(Boolean);
  if (scopes.some((s) => s !== SCOPE_FULL && s !== SCOPE_READ)) {
    throw new OAuthError("invalid_scope", `only scopes "${SCOPE_FULL}" and "${SCOPE_READ}" are supported`);
  }
  // An empty scope parameter means the default (full); a client asking only for vault:read gets read-only.
  // The scope strings "vault" and "vault:read" predate the rename and are kept: issued tokens carry them.
  const scope = scopes.length === 0 || scopes.includes(SCOPE_FULL) ? SCOPE_FULL : SCOPE_READ;
  return { client_id, redirect_uri, code_challenge, state: params.get("state") ?? undefined, scope, client };
}

export function issueCodeFor(req: AuthorizeRequest, email: string) {
  return issueAuthCode(jwtEnv(), {
    client_id: req.client_id,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    email,
    scope: req.scope ?? SCOPE_FULL,
  });
}

export function redirectWithParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

// ---- token -----------------------------------------------------------------

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function mint(email: string, client_id: string, scope: string): Promise<TokenResponse> {
  const env = jwtEnv();
  const [access_token, refresh_token] = await Promise.all([
    issueAccessToken(env, { email, client_id, scope }),
    issueRefreshToken(env, { email, client_id, scope }),
  ]);
  return { access_token, token_type: "Bearer", expires_in: 24 * 3600, refresh_token, scope };
}

export async function handleTokenRequest(form: URLSearchParams): Promise<TokenResponse> {
  const grant = form.get("grant_type");
  const env = jwtEnv();
  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const client_id = form.get("client_id") ?? "";
    const redirect_uri = form.get("redirect_uri");
    let claims;
    try {
      claims = await verifyAuthCode(env, code);
    } catch {
      throw new OAuthError("invalid_grant", "authorization code is invalid or expired");
    }
    if (client_id && claims.client_id !== client_id) throw new OAuthError("invalid_grant", "client_id mismatch");
    if (redirect_uri && claims.redirect_uri !== redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri mismatch");
    if (!verifyPkce(verifier, claims.code_challenge)) throw new OAuthError("invalid_grant", "PKCE verification failed");
    // Single use (RFC 6749 4.1.2), checked after PKCE so a party without the verifier cannot burn the code.
    if (!(await redeemOnce("code", onceKey(code, claims.jti)))) throw new OAuthError("invalid_grant", "authorization code was already used");
    return mint(claims.email, claims.client_id, claims.scope ?? SCOPE_FULL);
  }
  if (grant === "refresh_token") {
    const token = form.get("refresh_token") ?? "";
    const client_id = form.get("client_id") ?? "";
    let claims;
    try {
      claims = await verifyRefreshToken(env, token);
    } catch {
      throw new OAuthError("invalid_grant", "refresh token is invalid or expired");
    }
    if (client_id && claims.client_id !== client_id) throw new OAuthError("invalid_grant", "client_id mismatch");
    // Refresh tokens are not rotated or single-use: they stay stateless JWTs so that several processes of one client
    // can refresh concurrently with the same token. Rotation with reuse detection would make the losers of such a race
    // fail (and, done properly, revoke the whole grant). See docs/security.md.
    return mint(claims.email, claims.client_id, claims.scope);
  }
  throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

// ---- bearer verification for the MCP resource -----------------------------

function matches(token: string, list: string[]): boolean {
  const t = Buffer.from(token);
  return list.some((s) => {
    const b = Buffer.from(s);
    return b.length === t.length && timingSafeEqual(b, t);
  });
}

/** The 401 text for a bearer that was sent but is not valid (mcp-handler's own text says none was sent). */
export const INVALID_BEARER = "Invalid or expired access token; sign in again (re-authorize the client)";

/**
 * Used by withMcpAuth: JWT access tokens, full static tokens, read-only static tokens. No bearer resolves undefined
 * (mcp-handler answers 401 "No authorization provided"); a bearer that does not verify throws an invalid_token error,
 * so the 401 says the token was bad rather than missing.
 */
export async function verifyBearer(_req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
  const info = await bearerInfo(bearer);
  if (!info) throw new McpOAuthError(OAuthErrorCode.InvalidToken, INVALID_BEARER);
  return info;
}

async function bearerInfo(bearer: string): Promise<AuthInfo | undefined> {
  if (matches(bearer, staticTokens())) {
    return { token: bearer, clientId: "static", scopes: [SCOPE_FULL], extra: { email: "static-token" } };
  }
  if (matches(bearer, readonlyTokens())) {
    return { token: bearer, clientId: "static-readonly", scopes: [SCOPE_READ], extra: { email: "readonly-token" } };
  }
  if (!env("JWT_SECRET")) return undefined;
  try {
    const claims = await verifyAccessToken(jwtEnv(), bearer);
    return {
      token: bearer,
      clientId: claims.client_id,
      scopes: [claims.scope || SCOPE_FULL],
      expiresAt: claims.exp,
      extra: { email: claims.email },
    };
  } catch {
    return undefined;
  }
}

export function actorOf(auth: AuthInfo | undefined): string {
  const email = auth?.extra && typeof auth.extra.email === "string" ? auth.extra.email : undefined;
  return email ?? auth?.clientId ?? "anonymous";
}
