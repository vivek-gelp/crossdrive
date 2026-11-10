import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { assertMailAllowed, assertRecipientsAllowed, recipientAllowed } from "./access";
import { appendAudit, auditIdDay, getAuditEntry, readAudit } from "./audit";
import { DriveClient } from "./drive";
import { decodeCursor, encodeCursor, withTimeout } from "./find";
import { GmailClient } from "./gmail";
import { guardResult, MAX_RESULT_CHARS, withResultGuard } from "./guard";
import { buildInstructions } from "./instructions";
import { namingRule } from "./naming";
import { checkName, inboxFolder } from "./ctx";
import { fetchWithRetry, MAX_TRIES, retryDelayMs, setRetrySleep } from "./retry";
import { assertPublicHttpsUrl, guardedSourceFetch, isBlockedAddress, setHostResolver } from "./ssrf";
import { setStore } from "./store";
import { memoryStore } from "./testing/fakeDrive";

const json = (b: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json", ...headers } });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("naming rule and inbox config", () => {
  it("is off by default: every name passes", () => {
    expect(namingRule()).toBe("off");
    expect(() => checkName("notes.txt", "text/plain", false)).not.toThrow();
  });
  it("date-entity enforces YYYY-MM-DD_Company_WhatItIs.ext unless allowed", () => {
    vi.stubEnv("VAULT_NAMING_RULE", "date-entity");
    expect(() => checkName("notes.txt", "text/plain", false)).toThrow(/naming rule/);
    expect(() => checkName("notes.txt", "text/plain", true)).not.toThrow();
    expect(() => checkName("2026-11-10_Acme_Notes.txt", "text/plain", false)).not.toThrow();
  });
  it("inbox folder defaults to Inbox and follows VAULT_INBOX_FOLDER", () => {
    expect(inboxFolder()).toBe("Inbox");
    vi.stubEnv("VAULT_INBOX_FOLDER", "To File");
    expect(inboxFolder()).toBe("To File");
    vi.stubEnv("VAULT_INBOX_FOLDER", "bad/name");
    expect(inboxFolder()).toBe("Inbox");
  });
});

describe("access gates", () => {
  it("mail off blocks everything, draft blocks sending, read mode blocks every mail write", () => {
    expect(() => assertMailAllowed({ label: "work", mail: "off" }, "read")).toThrow(/mail is turned off for account work/);
    expect(() => assertMailAllowed({ label: "work", mail: "draft" }, "draft")).not.toThrow();
    expect(() => assertMailAllowed({ label: "work", mail: "draft" }, "send")).toThrow(/only create drafts.*mail_draft/);
    expect(() => assertMailAllowed({ label: "work", mode: "read" }, "read")).not.toThrow();
    expect(() => assertMailAllowed({ label: "work", mode: "read" }, "modify")).toThrow("account work is read-only; change it on /connect");
    expect(() => assertMailAllowed({ label: "work" }, "send")).not.toThrow();
  });
  it("recipient allow-list matches addresses and @domains, ignoring display names and case", () => {
    const allow = ["@example.com", "bob@partner.example"];
    expect(recipientAllowed("Alex <ALEX@example.com>", allow)).toBe(true);
    expect(recipientAllowed("bob@partner.example", allow)).toBe(true);
    expect(recipientAllowed("eve@partner.example", allow)).toBe(false);
    expect(recipientAllowed("x@sub.example.com", allow)).toBe(false);
    expect(recipientAllowed("anyone@anywhere.example", [])).toBe(true);
    vi.stubEnv("VAULT_MAIL_ALLOWED_RECIPIENTS", "@example.com");
    expect(() => assertRecipientsAllowed(["a@example.com", "Eve <eve@evil.example>"])).toThrow(/eve@evil\.example is not in the allowed recipients/);
  });
});

describe("retry", () => {
  let sleeps: number[];
  beforeEach(() => {
    sleeps = [];
    setRetrySleep(async (ms) => void sleeps.push(ms));
  });
  afterEach(() => setRetrySleep(undefined));

  it("retries 429 honouring Retry-After, then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(json({}, 429, { "Retry-After": "2" })).mockResolvedValueOnce(json({ ok: 1 }));
    const r = await fetchWithRetry(f as unknown as typeof fetch, "https://x.example/a", {}, { idempotent: false });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2000]);
  });
  it("retries 403 rate-limit reasons but not other 403s", async () => {
    const rate = () => json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403);
    const f = vi.fn().mockResolvedValueOnce(rate()).mockResolvedValueOnce(json({}));
    expect((await fetchWithRetry(f as unknown as typeof fetch, "https://x.example", {}, { idempotent: true })).status).toBe(200);
    const g = vi.fn().mockResolvedValue(json({ error: { errors: [{ reason: "insufficientPermissions" }] } }, 403));
    expect((await fetchWithRetry(g as unknown as typeof fetch, "https://x.example", {}, { idempotent: true })).status).toBe(403);
    expect(g).toHaveBeenCalledTimes(1);
  });
  it("retries 5xx only for idempotent calls, at most MAX_TRIES times, with growing jittered delays", async () => {
    const f = vi.fn().mockImplementation(async () => json({}, 503));
    expect((await fetchWithRetry(f as unknown as typeof fetch, "https://x.example", {}, { idempotent: true })).status).toBe(503);
    expect(f).toHaveBeenCalledTimes(MAX_TRIES);
    expect(sleeps).toHaveLength(MAX_TRIES - 1);
    const p = vi.fn().mockImplementation(async () => json({}, 503));
    await fetchWithRetry(p as unknown as typeof fetch, "https://x.example", { method: "POST" }, { idempotent: false });
    expect(p).toHaveBeenCalledTimes(1);
    expect(retryDelayMs(1, null, () => 0)).toBe(250);
    expect(retryDelayMs(3, null, () => 1)).toBe(2000);
    expect(retryDelayMs(10, null, () => 1)).toBe(8000);
  });
  it("DriveClient retries a rate-limited GET; GmailClient never retries a send", async () => {
    const d = vi.fn().mockResolvedValueOnce(json({}, 429)).mockResolvedValueOnce(json({ id: "root1" }));
    expect(await new DriveClient("t", d as unknown as typeof fetch).rootId()).toBe("root1");
    const g = vi.fn().mockImplementation(async () => json({ error: { message: "slow down" } }, 429));
    await expect(new GmailClient("t", g as unknown as typeof fetch).sendMessage("raw")).rejects.toThrow(/429/);
    expect(g).toHaveBeenCalledTimes(1);
    const l = vi.fn().mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json({ labels: [] }));
    expect(await new GmailClient("t", l as unknown as typeof fetch).listLabels()).toEqual([]);
  });
});

describe("result size guard", () => {
  it("passes small results through and wraps large ones with truncated=true and a paging hint", () => {
    const small = { content: [{ type: "text", text: "ok" }] };
    expect(guardResult("read", small)).toBe(small);
    const big = { content: [{ type: "text", text: JSON.stringify({ content: '"'.repeat(200_000) }) }] };
    const out = guardResult("read", big);
    const text = out.content[0]!.text!;
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ truncated: true, tool: "read", originalChars: big.content[0]!.text.length });
    expect(parsed.howToPage).toMatch(/offset/);
  });
  it("withResultGuard wraps every registered handler", async () => {
    const handlers: Record<string, (a: unknown) => Promise<{ content: { type: string; text: string }[] }>> = {};
    const server = { registerTool: (n: string, _d: unknown, h: (a: unknown) => Promise<{ content: { type: string; text: string }[] }>) => void (handlers[n] = h) } as unknown as McpServer;
    withResultGuard(server).registerTool("list", {} as never, (async () => ({ content: [{ type: "text", text: "x".repeat(70_000) }] })) as never);
    const r = await handlers.list!({});
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ truncated: true, howToPage: expect.stringMatching(/nextPageToken/) });
  });
});

describe("SSRF guard", () => {
  afterEach(() => setHostResolver(undefined));
  it("blocks loopback, private, link-local, CGNAT, mapped and non-https URLs", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
    await expect(assertPublicHttpsUrl("http://files.example.com/a")).rejects.toThrow(/https/);
    await expect(assertPublicHttpsUrl("https://127.0.0.1/a")).rejects.toThrow(/private, loopback/);
    await expect(assertPublicHttpsUrl("https://[::1]/a")).rejects.toThrow(/private, loopback/);
    await expect(assertPublicHttpsUrl("https://localhost/a")).rejects.toThrow(/not a public internet host/);
    await expect(assertPublicHttpsUrl("https://metadata.google.internal/a")).rejects.toThrow(/not a public internet host/);
    await expect(assertPublicHttpsUrl("https://intranet/a")).rejects.toThrow(/not a public internet host/);
  });
  it("checks DNS answers and every redirect hop", async () => {
    setHostResolver(async (h) => (h === "evil.example" ? ["10.0.0.7"] : ["93.184.216.34"]));
    await expect(assertPublicHttpsUrl("https://evil.example/a")).rejects.toThrow(/resolves to a private/);
    const f = vi.fn(async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes("start")) return new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/latest/meta-data" } });
      return new Response("data");
    });
    await expect(guardedSourceFetch(f as unknown as typeof fetch)("https://files.example.com/start")).rejects.toThrow(/private, loopback/);
    expect(f).toHaveBeenCalledTimes(1);
    const ok = vi.fn(async (u: string | URL | Request) =>
      String(u).includes("start") ? new Response(null, { status: 301, headers: { Location: "/final" } }) : new Response("data"),
    );
    const res = await guardedSourceFetch(ok as unknown as typeof fetch)("https://files.example.com/start");
    expect(await res.text()).toBe("data");
    expect(String(ok.mock.calls[1]![0])).toBe("https://files.example.com/final");
  });
});

describe("find cursor and timeout", () => {
  it("round-trips and rejects foreign tokens", () => {
    const c = { v: 1 as const, p: 5, a: { work: { t: "tok", s: 2 }, personal: { s: 3 } } };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(() => decodeCursor("not-a-cursor")).toThrow(/not a find cursor/);
  });
  it("withTimeout rejects slow work with the account named", async () => {
    await expect(withTimeout(new Promise(() => undefined), 10, "account work")).rejects.toThrow(/account work did not answer/);
    expect(await withTimeout(Promise.resolve(7), 1000, "x")).toBe(7);
  });
});

describe("audit log", () => {
  beforeEach(() => setStore(memoryStore()));
  afterEach(() => setStore(undefined));

  it("writes one blob per entry with a stable id and reads it back by id", async () => {
    const store = memoryStore();
    setStore(store);
    const e = await appendAudit({ tool: "move", account: "work", fileId: "f1", actor: "test" });
    expect(e.id).toMatch(/^\d{8}T\d{9}Z-[0-9a-f]{8}$/);
    const paths = await store.listPaths("audit/");
    expect(paths).toEqual([`audit/${e.ts.slice(0, 10)}/${e.id}.json`]);
    expect(await getAuditEntry(e.id)).toEqual(e);
    expect(auditIdDay(e.id)).toBe(e.ts.slice(0, 10));
  });
  it("keeps order within a millisecond and merges legacy jsonl days with stable legacy ids", async () => {
    const store = memoryStore();
    setStore(store);
    const day = new Date().toISOString().slice(0, 10);
    await store.write(`audit/${day}.jsonl`, `${JSON.stringify({ ts: `${day}T00:00:00.000Z`, tool: "rename", account: "work", actor: "old" })}\n`);
    for (let i = 0; i < 5; i++) await appendAudit({ tool: `t${i}`, account: "work", actor: "test" });
    const entries = await readAudit(10);
    expect(entries.map((x) => x.tool)).toEqual(["t4", "t3", "t2", "t1", "t0", "rename"]);
    const legacy = entries[5]!;
    expect(legacy.id).toMatch(new RegExp(`^legacy-${day}-[0-9a-f]{16}$`));
    expect((await readAudit(10))[5]!.id).toBe(legacy.id);
    expect(await getAuditEntry(legacy.id)).toMatchObject({ tool: "rename", actor: "old" });
  });
});

describe("instructions", () => {
  const accounts = [
    { label: "work", scopes: ["drive", "gmail.modify", "gmail.compose", "gmail.send"] },
    { label: "personal", mode: "read" as const, mail: "off" as const },
    { label: "client-a", mail: "draft" as const, scopes: ["drive", "gmail.modify", "gmail.compose", "gmail.send"] },
  ];
  it("lists the connected labels with their settings and the active config", () => {
    const s = buildInstructions(accounts, { full: true });
    expect(s).toContain("work (mail: can send)");
    expect(s).toContain("personal (read-only, no mail)");
    expect(s).toContain("client-a (mail: drafts only)");
    expect(s).toContain('"Inbox" folder');
    expect(s).toContain("Sending is disabled for client-a");
    expect(s).not.toMatch(/YYYY-MM-DD/);
    vi.stubEnv("VAULT_NAMING_RULE", "date-entity");
    vi.stubEnv("VAULT_MAIL_ALLOWED_RECIPIENTS", "@example.com");
    const t = buildInstructions(accounts, { full: true });
    expect(t).toMatch(/YYYY-MM-DD_Company_WhatItIs\.ext/);
    expect(t).toContain("Mail can only be sent to: @example.com");
  });
  it("says so for read-only tokens and when nothing is connected", () => {
    expect(buildInstructions(accounts, { full: false })).toContain("This token is read-only");
    expect(buildInstructions([], { full: true })).toContain("No accounts are connected yet");
  });
});
