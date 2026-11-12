import { createHash } from "node:crypto";
import { getStore } from "./store";

/**
 * Single-use markers for otherwise stateless OAuth artefacts (authorization codes, consent approvals). The first
 * redemption creates `oauth-used/<kind>/<key>` with create-if-absent semantics; a second redemption finds it and is
 * refused. Markers only need to outlive the artefact they guard (minutes), so old markers are never read again and
 * can be removed at any time.
 *
 * With Vercel Blob the create is atomic (allowOverwrite: false). With the in-memory store (no BLOB_READ_WRITE_TOKEN)
 * a marker lives only in the instance that wrote it, so the guarantee holds per instance: best effort, never an error.
 */

export type OnceKind = "code" | "consent";

/** Key for a token: its `jti` when it has a usable one, else a hash of the whole token (tokens issued before 1.0.1). */
export function onceKey(token: string, jti: unknown): string {
  if (typeof jti === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(jti)) return jti;
  return createHash("sha256").update(token).digest("base64url");
}

/** True when this call is the first use of `key`; false when it was used before. Store errors propagate (fail closed). */
export async function useOnce(kind: OnceKind, key: string): Promise<boolean> {
  const store = getStore();
  const path = `oauth-used/${kind}/${key}`;
  const marker = JSON.stringify({ usedAt: new Date().toISOString() });
  if (store.createIfAbsent) return store.createIfAbsent(path, marker);
  if ((await store.read(path)) !== null) return false;
  await store.write(path, marker);
  return true;
}
