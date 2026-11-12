import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountStatus, baseUrlMismatch, configWarnings, registerTokenChecker } from "./status";
import { saveAccounts, setStore, setTokenFetch, type Account } from "./store";
import { memoryStore } from "./testing/fakeDrive";

const ENV_KEYS = [
  "VAULT_ENC_KEY",
  "VAULT_JWT_SECRET",
  "VAULT_BASE_URL",
  "VAULT_ALLOWED_EMAILS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "BLOB_READ_WRITE_TOKEN",
  "VERCEL_ENV",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;
const saved: Record<string, string | undefined> = {};

const GMAIL = ["drive", "gmail.compose", "gmail.modify", "gmail.send"];

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  Object.assign(process.env, {
    VAULT_ENC_KEY: Buffer.alloc(32, 3).toString("base64"),
    VAULT_JWT_SECRET: Buffer.alloc(32, 4).toString("base64"),
    VAULT_BASE_URL: "https://vault.example.com",
    VAULT_ALLOWED_EMAILS: "alex@example.com",
    GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "csecret",
    BLOB_READ_WRITE_TOKEN: "blob",
  });
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  setStore(memoryStore());
  const accounts: Account[] = [
    { label: "personal", email: "alex@example.com", refresh_token: "good", connectedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), scopes: GMAIL },
    { label: "work", email: "sam@example.org", refresh_token: "revoked", connectedAt: "2026-01-01T00:00:00Z", mode: "read", mail: "off", provider: "google" },
  ];
  await saveAccounts(accounts);
  setTokenFetch((async (_url: string, init: RequestInit) => {
    const rt = new URLSearchParams(String(init.body)).get("refresh_token");
    if (rt === "good") return new Response(JSON.stringify({ access_token: "at", expires_in: 3599 }), { status: 200 });
    return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 });
  }) as unknown as typeof fetch);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setStore(undefined);
  setTokenFetch(undefined);
});

describe("accountStatus", () => {
  it("reports every account with a live token check and no secrets", async () => {
    const { accounts, warnings } = await accountStatus();
    expect(accounts.map((a) => a.label)).toEqual(["personal", "work"]);
    const [p, w] = accounts;
    expect(p).toMatchObject({
      label: "personal",
      email: "alex@example.com",
      provider: "google",
      mode: "write",
      mail: "send", // legacy record without mail field
      scopes: GMAIL,
      ageDays: 3,
      gmail: true,
      storage: "memory",
      token: { ok: true, expiresInSec: 3599 },
    });
    expect(p?.token.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(w).toMatchObject({ mode: "read", mail: "off", gmail: false, scopes: ["drive"], token: { ok: false } });
    expect(w?.token.error).toMatch(/invalid_grant.*reconnect/);
    expect(warnings.some((x) => x.startsWith("work: token check failed"))).toBe(true);
    expect(JSON.stringify(accounts)).not.toMatch(/"good"|"revoked"|refresh_token/);
  });

  it("filters by label and names connected labels for an unknown one", async () => {
    const { accounts } = await accountStatus("work");
    expect(accounts).toHaveLength(1);
    await expect(accountStatus("client-a")).rejects.toThrow(/connected: personal, work/);
  });

  it("uses a registered checker for other providers and flags providers without one", async () => {
    await saveAccounts([
      { label: "files", email: "alex@example.com", refresh_token: "x", connectedAt: "2026-01-01T00:00:00Z", provider: "dropbox" },
      { label: "office", email: "sam@example.org", refresh_token: "y", connectedAt: "2026-01-01T00:00:00Z", provider: "microsoft" },
    ]);
    registerTokenChecker("microsoft", async () => ({ expiresInSec: 100 }));
    const { accounts } = await accountStatus();
    expect(accounts.find((a) => a.label === "office")?.token).toMatchObject({ ok: true, expiresInSec: 100 });
    expect(accounts.find((a) => a.label === "files")?.token.ok).toBe(false);
    expect(accounts.find((a) => a.label === "files")?.gmail).toBe(false);
  });

  it("warns when nothing is connected", async () => {
    await saveAccounts([]);
    const { accounts, warnings } = await accountStatus();
    expect(accounts).toEqual([]);
    expect(warnings.join(" ")).toMatch(/No accounts connected/);
  });
});

describe("configWarnings", () => {
  it("is empty for a complete configuration", () => {
    expect(configWarnings()).toEqual([]);
  });
  it("lists missing env var names (never values) and the memory store", () => {
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    const w = configWarnings();
    expect(w[0]).toBe("Missing environment variables: GOOGLE_CLIENT_SECRET.");
    expect(w.join(" ")).toMatch(/in-memory storage/);
    expect(w.join(" ")).not.toContain("cid");
  });
  it("flags VAULT_BASE_URL that differs from the Vercel production host", () => {
    process.env.VERCEL_ENV = "production";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "my-vault.vercel.app";
    expect(configWarnings().join(" ")).toMatch(/vault\.example\.com.*my-vault\.vercel\.app/);
  });
  it("baseUrlMismatch compares hosts", () => {
    expect(baseUrlMismatch("https://a.example.com", "https://a.example.com")).toBeNull();
    expect(baseUrlMismatch("https://a.example.com/", "https://b.example.com")).toMatch(/differs/);
    expect(baseUrlMismatch("not a url", "https://b.example.com")).toMatch(/not a valid URL/);
  });
});
