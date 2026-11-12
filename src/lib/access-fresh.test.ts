import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertAccountWritable } from "./access";
import { encryptJson } from "./crypto";
import { mailCtxFor } from "./mail";
import { assertWriteMode } from "./providers/guards";
import { getAccount, loadAccounts, setStore, type Account, type TextStore } from "./store";
import { memoryStore } from "./testing/fakeDrive";

/**
 * Serverless instances do not share memory. A switch to read-only (or mail "draft", or a disconnect) made on /connect
 * is written to the store by one instance; every other instance must honour it on its very next write call, not
 * when its account cache expires. These tests warm this instance's cache, then change the stored record behind its
 * back (as another instance would) and expect the gates to see the change at once.
 */

const KEY = Buffer.alloc(32, 9).toString("base64");

const acct = (extra: Partial<Account> = {}): Account => ({
  label: "personal",
  email: "alex@example.com",
  refresh_token: "rt-personal",
  connectedAt: "2026-01-01T00:00:00.000Z",
  scopes: ["drive", "gmail.modify", "gmail.compose", "gmail.send"],
  ...extra,
});

let store: TextStore;
/** Write the account list the way another instance would: straight to the store, bypassing this instance's cache. */
const writeBehindCache = (accounts: Account[]) => store.write("accounts.enc", encryptJson(accounts, KEY));

beforeEach(async () => {
  process.env.VAULT_ENC_KEY = KEY;
  store = memoryStore();
  setStore(store);
  await writeBehindCache([acct({ mode: "write", mail: "send" })]);
  await loadAccounts(true); // warm this instance's cache with the old record
});

afterEach(() => {
  setStore(undefined);
  delete process.env.VAULT_ENC_KEY;
});

describe("access gates read the account fresh", () => {
  it("the cache is stale on purpose, but the write gate is not", async () => {
    await writeBehindCache([acct({ mode: "read" })]);
    expect((await getAccount("personal")).mode).toBe("write"); // cached read path: still the old record
    await expect(assertAccountWritable({ label: "personal" })).rejects.toThrow("account personal is read-only; change it on /connect");
  });

  it("the cloud_*/transfer gate is fresh too and words the refusal the same way", async () => {
    await writeBehindCache([acct({ mode: "read" })]);
    await expect(assertWriteMode({ label: "personal" })).rejects.toThrow("account personal is read-only; change it on /connect");
  });

  it("a disconnect elsewhere refuses writes at once", async () => {
    await writeBehindCache([]);
    await expect(assertAccountWritable({ label: "personal" })).rejects.toThrow(/No connected account labelled "personal"/);
  });

  it("mail mode changes apply at once (send -> draft, then off)", async () => {
    await writeBehindCache([acct({ mail: "draft" })]);
    await expect(mailCtxFor("personal", "send")).rejects.toThrow(/may only create drafts/);
    await writeBehindCache([acct({ mail: "off" })]);
    await expect(mailCtxFor("personal", "read")).rejects.toThrow(/mail is turned off/);
  });

  it("a switch back to write applies at once as well", async () => {
    await writeBehindCache([acct({ mode: "read" })]);
    await expect(assertAccountWritable({ label: "personal" })).rejects.toThrow(/read-only/);
    await writeBehindCache([acct({ mode: "write" })]);
    await expect(assertAccountWritable({ label: "personal" })).resolves.toBeUndefined();
  });

  it("costs one store read per gate call", async () => {
    let reads = 0;
    const inner = store;
    setStore({ ...inner, kind: "memory", read: (p) => (reads++, inner.read(p)), write: inner.write, listPaths: inner.listPaths });
    await assertAccountWritable({ label: "personal" });
    expect(reads).toBe(1);
  });
});

describe("every gate call is awaited", () => {
  // The gates are async; a call without `await` would let the write through. Guard the call sites statically.
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return sources(p);
      return /\.tsx?$/.test(n) && !n.endsWith(".test.ts") ? [p] : [];
    });
  }
  it("assertAccountWritable / assertWriteMode / assertCopyAllowed are never called without await", () => {
    const root = join(__dirname, "..", "..");
    const offenders: string[] = [];
    for (const file of [...sources(join(root, "src")), ...sources(join(root, "app"))]) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\*|\/\/)/.test(line) || /\bfunction\s+(assertAccountWritable|assertWriteMode|assertCopyAllowed)\b/.test(line)) return;
          for (const m of line.matchAll(/\b(assertAccountWritable|assertWriteMode|assertCopyAllowed)\(/g)) {
            const before = line.slice(0, m.index);
            if (!/\bawait\s+$/.test(before)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
