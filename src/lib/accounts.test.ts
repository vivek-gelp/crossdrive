import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectedAccountRecord, disconnectAccount, disconnectAll, setAccountMail, setAccountMode, setRevokeFetch } from "./accounts";
import { readAudit } from "./audit";
import { LABEL_RE, isValidLabel } from "./config";
import { encryptJson } from "./crypto";
import { assertKnownLabel, loadAccounts, saveAccounts, setStore, upsertAccount, type Account } from "./store";
import { memoryStore } from "./testing/fakeDrive";
import { label as labelSchema } from "./toolkit";

const KEY = Buffer.alloc(32, 9).toString("base64");

const acct = (label: string, email: string, extra: Partial<Account> = {}): Account => ({
  label,
  email,
  refresh_token: `rt-${label}`,
  connectedAt: "2026-01-01T00:00:00.000Z",
  scopes: ["drive"],
  ...extra,
});

let revoked: string[];
let revokeStatus: number;

beforeEach(async () => {
  process.env.VAULT_ENC_KEY = KEY;
  setStore(memoryStore());
  revoked = [];
  revokeStatus = 200;
  setRevokeFetch((async (url: string, init: RequestInit) => {
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    revoked.push(new URLSearchParams(String(init.body)).get("token") ?? "");
    return new Response(revokeStatus === 200 ? "{}" : JSON.stringify({ error: "server_error" }), { status: revokeStatus });
  }) as unknown as typeof fetch);
});

afterEach(() => {
  setStore(undefined);
  setRevokeFetch(undefined);
  delete process.env.VAULT_ENC_KEY;
});

describe("labels", () => {
  it("accepts user-chosen labels and rejects bad ones", () => {
    for (const ok of ["personal", "work", "client-a", "a", "a".repeat(24), "x1-2"]) expect(isValidLabel(ok), ok).toBe(true);
    for (const bad of ["", "Work", "1abc", "-a", "a_b", "a b", "a".repeat(25), "a:b"]) expect(isValidLabel(bad), bad).toBe(false);
    expect(LABEL_RE.test("client-a")).toBe(true);
  });
  it("tool label schema validates the format, not a fixed list", () => {
    expect(labelSchema.safeParse("client-a").success).toBe(true);
    expect(labelSchema.safeParse("Client A").success).toBe(false);
  });
  it("assertKnownLabel names the connected labels", async () => {
    await saveAccounts([acct("personal", "alex@example.com"), acct("work", "sam@example.org")]);
    await expect(assertKnownLabel("client-a")).rejects.toThrow(/connected: personal, work/);
    await expect(assertKnownLabel("Bad Label")).rejects.toThrow(/Invalid label/);
    expect((await assertKnownLabel("work")).email).toBe("sam@example.org");
  });
  it("upsertAccount refuses an invalid label", async () => {
    await expect(upsertAccount(acct("Not Valid", "alex@example.com"))).rejects.toThrow(/Invalid label/);
  });
});

describe("legacy records", () => {
  it("load unchanged without provider/mode/mail and keep working through updates", async () => {
    const legacy = [{ label: "personal", email: "alex@example.com", refresh_token: "rt", connectedAt: "2025-05-01T00:00:00Z" }];
    const store = memoryStore();
    setStore(store);
    await store.write("accounts.enc", encryptJson(legacy, KEY));
    const [a] = await loadAccounts(true);
    expect(a).toMatchObject({ label: "personal", scopes: ["drive"] });
    expect(a?.provider).toBeUndefined();
    expect(a?.mail).toBeUndefined();
    await setAccountMode("personal", "read", "alex@example.com");
    const [b] = await loadAccounts(true);
    expect(b?.mode).toBe("read");
    expect(b?.mail).toBeUndefined();
  });
});

describe("connectedAccountRecord", () => {
  const fresh = { label: "work", email: "sam@example.org", refresh_token: "new", scopes: ["drive", "gmail.modify"], provider: "google" as const };
  const now = new Date("2026-02-02T00:00:00Z");
  it("defaults new Google accounts to write + draft", () => {
    expect(connectedAccountRecord(fresh, undefined, now)).toEqual({ ...fresh, connectedAt: now.toISOString(), mode: "write", mail: "draft" });
  });
  it("keeps mode and mail on reconnect, including a legacy absent mail", () => {
    const r1 = connectedAccountRecord(fresh, acct("work", "sam@example.org", { mode: "read", mail: "off" }), now);
    expect(r1).toMatchObject({ mode: "read", mail: "off", refresh_token: "new" });
    const r2 = connectedAccountRecord(fresh, acct("work", "sam@example.org"), now);
    expect("mail" in r2).toBe(false);
    expect("mode" in r2).toBe(false);
  });
  it("defaults mail to off for providers without mail", () => {
    expect(connectedAccountRecord({ ...fresh, provider: "dropbox" }, undefined, now).mail).toBe("off");
  });
});

describe("owner actions", () => {
  beforeEach(async () => {
    await saveAccounts([
      acct("personal", "alex@example.com"),
      acct("work", "sam@example.org", { provider: "google", mode: "write", mail: "draft" }),
      acct("client-a", "sam@example.org"),
      acct("files", "alex@example.com", { provider: "dropbox" }),
    ]);
  });

  it("sets mode and mail with validation and audit", async () => {
    await setAccountMode("work", "read", "alex@example.com");
    await setAccountMail("work", "send", "alex@example.com");
    const w = (await loadAccounts(true)).find((a) => a.label === "work");
    expect(w).toMatchObject({ mode: "read", mail: "send" });
    await expect(setAccountMode("work", "admin", "x")).rejects.toThrow(/mode must be/);
    await expect(setAccountMail("work", "always", "x")).rejects.toThrow(/mail must be/);
    await expect(setAccountMail("files", "send", "x")).rejects.toThrow(/only available for Google/);
    await expect(setAccountMode("nope", "read", "x")).rejects.toThrow(/No connected account/);
    const audit = await readAudit(10);
    expect(audit.map((e) => e.tool).sort()).toEqual(["admin_mail", "admin_mode"]);
    expect(audit[0]?.actor).toBe("alex@example.com");
  });

  it("disconnect revokes at Google then removes the account", async () => {
    const r = await disconnectAccount("personal", "alex@example.com");
    expect(r).toEqual({ label: "personal", email: "alex@example.com", revoked: true });
    expect(revoked).toEqual(["rt-personal"]);
    expect((await loadAccounts(true)).map((a) => a.label)).not.toContain("personal");
    expect((await readAudit(1))[0]).toMatchObject({ tool: "admin_disconnect", account: "personal", email: "alex@example.com" });
  });

  it("keeps the grant when another label uses the same Google account", async () => {
    const r = await disconnectAccount("work", "alex@example.com");
    expect(r.revoked).toBe("shared");
    expect(revoked).toEqual([]);
  });

  it("removes the account even when the revoke fails", async () => {
    revokeStatus = 500;
    const r = await disconnectAccount("personal", "alex@example.com");
    expect(r.revoked).toBe(false);
    expect((await loadAccounts(true)).map((a) => a.label).sort()).toEqual(["client-a", "files", "work"]);
  });

  it("disconnect-all revokes each Google grant once and empties the store", async () => {
    const rs = await disconnectAll("alex@example.com");
    expect(rs).toHaveLength(4);
    expect(revoked.sort()).toEqual(["rt-personal", "rt-work"]);
    expect(rs.find((r) => r.label === "client-a")?.revoked).toBe("shared");
    // no revoker registered for dropbox in this build
    expect(rs.find((r) => r.label === "files")?.revoked).toBe(false);
    expect(await loadAccounts(true)).toEqual([]);
    expect((await readAudit(10)).filter((e) => e.tool === "admin_disconnect")).toHaveLength(4);
  });
});
