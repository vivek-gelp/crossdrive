import { del, get, list, put } from "@vercel/blob";
import { decryptJson, encryptJson } from "./crypto";
import { encKey, isValidLabel, LABEL_RE } from "./config";
import type { AccountLabel } from "./config";
import { refreshAccessToken } from "./google";

/**
 * Persistence. Vercel Blob (private) when BLOB_READ_WRITE_TOKEN is present,
 * otherwise an in-memory map (loudly reported by /health; data is lost on
 * cold start).
 */

export interface Account {
  label: AccountLabel;
  email: string;
  refresh_token: string;
  connectedAt: string;
  /** Short names of the granted Google scopes (`drive`, `gmail.modify`, ...). Records from before 0.4.0 have none and mean `["drive"]`. */
  scopes?: string[];
  /** Storage provider. Absent on records from before 1.0 and means "google". */
  provider?: "google" | "microsoft" | "dropbox";
  /** Server-enforced access mode. Absent means "write". "read" blocks every write tool for this account. */
  mode?: "read" | "write";
  /** Mail capability (google only). Absent (legacy record) means "send"; new connections default to "draft". "off" hides mail entirely. */
  mail?: "off" | "draft" | "send";
}

export function accountProvider(a: Pick<Account, "provider">): "google" | "microsoft" | "dropbox" {
  return a.provider ?? "google";
}
export function accountMode(a: Pick<Account, "mode">): "read" | "write" {
  return a.mode ?? "write";
}
export function accountMail(a: Pick<Account, "mail">): "off" | "draft" | "send" {
  return a.mail ?? "send";
}

/** Short names of the three Gmail scopes the consent flow asks for; all must be granted for the mail tools. */
export const GMAIL_SCOPE_NAMES = ["gmail.modify", "gmail.compose", "gmail.send"] as const;

export function accountScopes(a: Pick<Account, "scopes">): string[] {
  return a.scopes && a.scopes.length > 0 ? a.scopes : ["drive"];
}

export function gmailGranted(a: Pick<Account, "scopes">): boolean {
  const have = accountScopes(a);
  return GMAIL_SCOPE_NAMES.every((s) => have.includes(s));
}

const ACCOUNTS_PATH = "accounts.enc";

// ---- raw text store ---------------------------------------------------------

export interface TextStore {
  kind: "blob" | "memory";
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** Every path under `prefix`, sorted. */
  listPaths(prefix: string): Promise<string[]>;
  /**
   * Create `path` only when it does not exist yet. Resolves true when this call created it, false when it existed.
   * Optional: without it, callers fall back to read-then-write (not atomic).
   */
  createIfAbsent?(path: string, text: string): Promise<boolean>;
  /**
   * One level below `prefix` (which ends in "/"): the sub-folders (each ending in "/") and the files directly in it,
   * both sorted. Optional: without it, callers derive the same from listPaths.
   */
  listTop?(prefix: string): Promise<{ folders: string[]; files: string[] }>;
  /**
   * Remove one bookkeeping blob (never a user's file: the store only holds Crossdrive's own records). Optional:
   * callers that need it fall back to writing a tombstone.
   */
  remove?(path: string): Promise<void>;
}

/** listTop for any store: the native one when present, else derived from a full listPaths. */
export async function listTopOf(store: TextStore, prefix: string): Promise<{ folders: string[]; files: string[] }> {
  if (store.listTop) return store.listTop(prefix);
  const folders = new Set<string>();
  const files: string[] = [];
  for (const p of await store.listPaths(prefix)) {
    const rest = p.slice(prefix.length);
    const i = rest.indexOf("/");
    if (i >= 0) folders.add(prefix + rest.slice(0, i + 1));
    else files.push(p);
  }
  return { folders: [...folders].sort(), files: files.sort() };
}

class MemoryStore implements TextStore {
  kind = "memory" as const;
  private readonly data = new Map<string, string>();
  async read(path: string) {
    return this.data.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.data.set(path, text);
  }
  async listPaths(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  async remove(path: string) {
    this.data.delete(path);
  }
  async createIfAbsent(path: string, text: string) {
    if (this.data.has(path)) return false;
    this.data.set(path, text);
    return true;
  }
}

/** Vercel Blob refuses `allowOverwrite: false` on an existing pathname with an "already exists" error. */
function isAlreadyExists(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === "BlobPreconditionFailedError" || /already exists/i.test(e.message);
}

class BlobStore implements TextStore {
  kind = "blob" as const;
  async read(path: string) {
    const r = await get(path, { access: "private", useCache: false });
    if (!r || r.statusCode !== 200) return null;
    return new Response(r.stream).text();
  }
  async write(path: string, text: string) {
    await put(path, text, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/octet-stream",
    });
  }
  async listPaths(prefix: string) {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix, limit: 1000, cursor });
      out.push(...r.blobs.map((b) => b.pathname));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.sort();
  }
  async createIfAbsent(path: string, text: string) {
    try {
      await put(path, text, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "application/octet-stream",
      });
      return true;
    } catch (e) {
      if (isAlreadyExists(e)) return false;
      throw e;
    }
  }
  async remove(path: string) {
    await del(path);
  }
  async listTop(prefix: string) {
    const folders: string[] = [];
    const files: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await list({ prefix, limit: 1000, cursor, mode: "folded" });
      folders.push(...r.folders.map((f) => (f.endsWith("/") ? f : `${f}/`)));
      files.push(...r.blobs.map((b) => b.pathname));
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return { folders: folders.sort(), files: files.sort() };
  }
}

let storeSingleton: TextStore | undefined;

export function getStore(): TextStore {
  if (!storeSingleton) {
    storeSingleton = process.env.BLOB_READ_WRITE_TOKEN ? new BlobStore() : new MemoryStore();
  }
  return storeSingleton;
}

/** Test seam. */
export function setStore(s: TextStore | undefined) {
  storeSingleton = s;
  accountsCache = undefined;
}

// ---- accounts ---------------------------------------------------------------

let accountsCache: { at: number; accounts: Account[] } | undefined;
/**
 * Per-instance cache of the account list for read paths (listing, status). Serverless instances do not share memory,
 * so a change made on /connect reaches other instances only when this expires; keep it short. Access gates (mode,
 * mail mode, disconnect) never use it: they read the record fresh (getAccount(label, { fresh: true })).
 */
export const ACCOUNTS_TTL_MS = 5_000;

export async function loadAccounts(force = false): Promise<Account[]> {
  if (!force && accountsCache && Date.now() - accountsCache.at < ACCOUNTS_TTL_MS) return accountsCache.accounts;
  const raw = await getStore().read(ACCOUNTS_PATH);
  // Records written before 0.4.0 carry no scopes: they were granted Drive only.
  const accounts = (raw ? decryptJson<Account[]>(raw, encKey()) : []).map((a) => ({ ...a, scopes: accountScopes(a) }));
  accountsCache = { at: Date.now(), accounts };
  return accounts;
}

export async function saveAccounts(accounts: Account[]): Promise<void> {
  await getStore().write(ACCOUNTS_PATH, encryptJson(accounts, encKey()));
  accountsCache = { at: Date.now(), accounts };
}

export async function upsertAccount(account: Account): Promise<Account[]> {
  if (!isValidLabel(account.label)) throw new Error(`Invalid label "${account.label}": must match ${LABEL_RE}`);
  const accounts = (await loadAccounts(true)).filter((a) => a.label !== account.label);
  accounts.push(account);
  accounts.sort((a, b) => a.label.localeCompare(b.label));
  await saveAccounts(accounts);
  return accounts;
}

export async function removeAccount(label: string): Promise<Account[]> {
  const accounts = (await loadAccounts(true)).filter((a) => a.label !== label);
  await saveAccounts(accounts);
  accessTokens.delete(label);
  return accounts;
}

/** The stored account for `label`. `fresh: true` bypasses the per-instance cache (one store read); access gates use it. */
export async function getAccount(label: string, opts: { fresh?: boolean } = {}): Promise<Account> {
  const accounts = await loadAccounts(opts.fresh === true);
  const a = accounts.find((x) => x.label === label);
  if (!a) {
    const have = accounts.map((x) => x.label).join(", ") || "none";
    throw new Error(`No connected account labelled "${label}" (connected: ${have}). Visit /connect to add it.`);
  }
  return a;
}

/** Same as getAccount; the name reads better at tool boundaries. Throws naming the connected labels. */
export async function assertKnownLabel(label: string): Promise<Account> {
  if (!isValidLabel(label)) throw new Error(`Invalid label "${label}": use lower-case letters, digits or hyphens, starting with a letter (max 24).`);
  return getAccount(label);
}

/** Change mode / mail of a stored account. Throws for an unknown label. */
export async function updateAccount(label: string, patch: Partial<Pick<Account, "mode" | "mail">>): Promise<Account> {
  const accounts = await loadAccounts(true);
  const i = accounts.findIndex((a) => a.label === label);
  const cur = accounts[i];
  if (!cur) throw new Error(`No connected account labelled "${label}"`);
  const next: Account = { ...cur, ...patch };
  accounts[i] = next;
  await saveAccounts(accounts);
  return next;
}

// ---- Google access tokens (memory only) ------------------------------------

const accessTokens = new Map<string, { token: string; exp: number }>();
let tokenFetch: typeof fetch | undefined;

/** Test seam: the fetch used to refresh Google access tokens. */
export function setTokenFetch(f: typeof fetch | undefined) {
  tokenFetch = f;
  accessTokens.clear();
}

/** Always asks Google for a fresh access token (proves the refresh token still works) and caches it. */
export async function refreshAccessTokenFor(account: Account): Promise<{ token: string; expiresInSec: number }> {
  assertGoogleToken(account);
  const t = await refreshAccessToken(account.refresh_token, tokenFetch ?? fetch);
  accessTokens.set(account.label, { token: t.access_token, exp: Date.now() + t.expires_in * 1000 });
  return { token: t.access_token, expiresInSec: t.expires_in };
}

/** Google access tokens only; OneDrive / Dropbox tokens come from providers/tokens.ts. */
function assertGoogleToken(account: Account): void {
  const p = accountProvider(account);
  if (p !== "google") {
    throw new Error(`"${account.label}" is a ${p === "microsoft" ? "OneDrive" : "Dropbox"} account; Google-only tools cannot use it. Use the cloud_* tools or transfer for it.`);
  }
}

export async function accessTokenFor(account: Account): Promise<string> {
  assertGoogleToken(account);
  const cached = accessTokens.get(account.label);
  if (cached && cached.exp - 60_000 > Date.now()) return cached.token;
  return (await refreshAccessTokenFor(account)).token;
}
