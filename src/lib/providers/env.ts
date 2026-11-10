/**
 * Environment and test seams for the non-Google providers.
 *
 * Env (unprefixed, read directly): MS_CLIENT_ID, MS_CLIENT_SECRET, optional MS_TENANT (default `common`, which accepts
 * personal and work/school accounts), DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET. The CROSSDRIVE_ variables they depend on
 * (CROSSDRIVE_BASE_URL for the redirect URIs, CROSSDRIVE_JWT_SECRET for the state) are read through config.ts `env()`.
 */
import { isValidLabel as isLabel, LABEL_RE } from "../config";

export { LABEL_RE };

export function isValidLabel(label: string): boolean {
  return isLabel(label);
}

export function microsoftClient(): { clientId: string; clientSecret: string; tenant: string } | null {
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const tenant = (process.env.MS_TENANT ?? "common").trim() || "common";
  if (!/^[A-Za-z0-9.-]+$/.test(tenant)) throw new Error("MS_TENANT must be common, organizations, consumers, a tenant id or a domain");
  return { clientId, clientSecret, tenant };
}

export function dropboxClient(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ---- test seams --------------------------------------------------------------

export type FetchLike = typeof fetch;

let providerFetch: FetchLike | undefined;
let sleeper: ((ms: number) => Promise<void>) | undefined;

/** Route every Microsoft Graph / Dropbox / token request through `f` (tests). */
export function setProviderFetch(f: FetchLike | undefined) {
  providerFetch = f;
}

export function currentProviderFetch(): FetchLike {
  return providerFetch ?? fetch;
}

/** Replace the back-off sleep (tests). */
export function setProviderSleep(s: ((ms: number) => Promise<void>) | undefined) {
  sleeper = s;
}

export function providerSleep(ms: number): Promise<void> {
  return sleeper ? sleeper(ms) : new Promise((r) => setTimeout(r, ms));
}
