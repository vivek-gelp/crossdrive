import { createHash, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

/**
 * All OAuth artefacts are stateless HS256 JWTs signed with CROSSDRIVE_JWT_SECRET.
 * The `use` claim separates token kinds so one cannot be replayed as another.
 */

export interface JwtEnv {
  secret: string;
  issuer: string;
}

export type TokenUse = "client" | "code" | "access" | "refresh" | "state" | "admin" | "consent";

export const TTL = {
  client: 10 * 365 * 24 * 3600,
  code: 5 * 60,
  access: 24 * 3600,
  refresh: 90 * 24 * 3600,
  state: 10 * 60,
  admin: 60 * 60,
  consent: 10 * 60,
} as const satisfies Record<TokenUse, number>;

interface IssueOpts {
  now?: number;
}

function keyOf(env: JwtEnv): Uint8Array {
  const k = Buffer.from(env.secret, "base64");
  if (k.length < 32) throw new Error("CROSSDRIVE_JWT_SECRET must decode to at least 32 bytes");
  return new Uint8Array(k);
}

async function issue(env: JwtEnv, use: TokenUse, claims: Record<string, unknown>, opts?: IssueOpts): Promise<string> {
  const now = opts?.now ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims, use })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(env.issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + TTL[use])
    .sign(keyOf(env));
}

async function verify<T extends JWTPayload>(env: JwtEnv, use: TokenUse, token: string): Promise<T & { iat: number; exp: number }> {
  const { payload } = await jwtVerify(token, keyOf(env), { issuer: env.issuer, algorithms: ["HS256"] });
  if (payload.use !== use) throw new Error(`token is not a ${use} token`);
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") throw new Error("token missing iat/exp");
  return payload as T & { iat: number; exp: number };
}

// ---- client_id -------------------------------------------------------------

export interface ClientClaims extends JWTPayload {
  redirect_uris: string[];
  client_name?: string;
}

export function issueClientId(env: JwtEnv, c: { redirect_uris: string[]; client_name?: string }, opts?: IssueOpts) {
  return issue(env, "client", { redirect_uris: c.redirect_uris, client_name: c.client_name }, opts);
}

export function verifyClientId(env: JwtEnv, token: string) {
  return verify<ClientClaims>(env, "client", token);
}

// ---- authorization code ----------------------------------------------------

export interface CodeClaims extends JWTPayload {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  email: string;
  scope?: string;
}

export function issueAuthCode(
  env: JwtEnv,
  c: { client_id: string; redirect_uri: string; code_challenge: string; email: string; scope?: string },
  opts?: IssueOpts,
) {
  return issue(env, "code", c, opts);
}

export function verifyAuthCode(env: JwtEnv, token: string) {
  return verify<CodeClaims>(env, "code", token);
}

// ---- access / refresh ------------------------------------------------------

export interface SessionClaims extends JWTPayload {
  email: string;
  client_id: string;
  scope: string;
}

export function issueAccessToken(env: JwtEnv, c: { email: string; client_id: string; scope: string }, opts?: IssueOpts) {
  return issue(env, "access", c, opts);
}

export function verifyAccessToken(env: JwtEnv, token: string) {
  return verify<SessionClaims>(env, "access", token);
}

export function issueRefreshToken(env: JwtEnv, c: { email: string; client_id: string; scope: string }, opts?: IssueOpts) {
  return issue(env, "refresh", c, opts);
}

export function verifyRefreshToken(env: JwtEnv, token: string) {
  return verify<SessionClaims>(env, "refresh", token);
}

// ---- Google round-trip state + admin session -------------------------------

export type StateClaims = JWTPayload &
  (
    | { purpose: "oauth"; client_id: string; redirect_uri: string; code_challenge: string; state?: string; scope?: string }
    | { purpose: "admin"; next?: string }
    | { purpose: "drive"; label: string }
  );

export function issueState(env: JwtEnv, c: Omit<StateClaims, keyof JWTPayload>, opts?: IssueOpts) {
  return issue(env, "state", c as Record<string, unknown>, opts);
}

export function verifyState(env: JwtEnv, token: string) {
  return verify<StateClaims>(env, "state", token);
}

export function issueAdminSession(env: JwtEnv, c: { email: string }, opts?: IssueOpts) {
  return issue(env, "admin", c, opts);
}

export function verifyAdminSession(env: JwtEnv, token: string) {
  return verify<JWTPayload & { email: string }>(env, "admin", token);
}

// ---- pending consent (owner signed in, approval not yet given) -----------

export interface PendingConsent {
  client_id: string;
  client_name?: string;
  redirect_uri: string;
  code_challenge: string;
  state?: string;
  /** The scope the client asked for; the approver may only keep or narrow it. */
  scope: string;
  email: string;
}
export type ConsentClaims = JWTPayload & PendingConsent;

export function issueConsent(env: JwtEnv, c: PendingConsent, opts?: IssueOpts) {
  return issue(env, "consent", { ...c }, opts);
}

export function verifyConsent(env: JwtEnv, token: string) {
  return verify<ConsentClaims>(env, "consent", token);
}

// ---- PKCE ------------------------------------------------------------------

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Strict RFC 7636 S256 check. The plain method is never accepted. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!VERIFIER_RE.test(codeVerifier)) return false;
  const expected = Buffer.from(createHash("sha256").update(codeVerifier).digest("base64url"));
  const given = Buffer.from(codeChallenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
