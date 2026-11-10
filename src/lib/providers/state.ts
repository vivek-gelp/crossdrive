/**
 * Stateless OAuth round-trip state for the Microsoft and Dropbox connect
 * flows: an HS256 JWT (CROSSDRIVE_JWT_SECRET, 10 minutes, its own `use` claim so
 * it cannot be replayed as any other token) carrying provider, label, the
 * admin who started it and a random nonce. The PKCE code_verifier is derived
 * from the nonce with an HMAC under the same secret, so the callback can
 * recompute it while the provider (and anyone reading the URL) only ever
 * sees the S256 challenge.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { jwtEnv } from "../config";

const USE = "provider-state";
const TTL_SECONDS = 600;

export interface ProviderState {
  provider: "microsoft" | "dropbox";
  label: string;
  /** Admin email that started the flow; the callback must see the same admin session. */
  admin: string;
  nonce: string;
}

function key(): Uint8Array {
  const k = Buffer.from(jwtEnv().secret, "base64");
  if (k.length < 32) throw new Error("CROSSDRIVE_JWT_SECRET must decode to at least 32 bytes");
  return new Uint8Array(k);
}

export function pkceVerifier(nonce: string): string {
  return createHmac("sha256", Buffer.from(key())).update(`pkce:${nonce}`).digest("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function issueProviderState(s: Omit<ProviderState, "nonce">): Promise<{ state: string; challenge: string }> {
  const nonce = randomBytes(24).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const state = await new SignJWT({ ...s, nonce, use: USE })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(jwtEnv().issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + TTL_SECONDS)
    .sign(key());
  return { state, challenge: pkceChallenge(pkceVerifier(nonce)) };
}

export async function verifyProviderState(token: string, provider: ProviderState["provider"]): Promise<ProviderState & { verifier: string }> {
  const { payload } = await jwtVerify(token, key(), { issuer: jwtEnv().issuer, algorithms: ["HS256"] });
  if (payload.use !== USE || payload.provider !== provider) throw new Error("state is not for this flow");
  const { label, admin, nonce } = payload as unknown as ProviderState;
  if (typeof label !== "string" || typeof admin !== "string" || typeof nonce !== "string") throw new Error("malformed state");
  return { provider, label, admin, nonce, verifier: pkceVerifier(nonce) };
}
