/**
 * Wiring of the OneDrive / Dropbox providers into the shared tool set: registration in tools.ts, the Google-only
 * guards, the accounts and find tools with mixed providers, instructions, token checks and revocation.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildInstructions } from "../instructions";
import { registerAllTools, registerReadTools } from "../tools";
import { setProviderFetch } from "./env";
import { call, collect, setupHarness, teardownHarness, ACCOUNTS, type Harness } from "./testing/harness";
import { checkProviderToken, DROPBOX_REVOKE_URL, revokeDropboxToken, revokeMicrosoftToken } from "./tokens";

vi.mock("../store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../store")>();
  const { providerStoreMock } = await import("./testing/storeMock");
  return { ...orig, ...providerStoreMock() };
});

let h: Harness;
beforeEach(() => {
  h = setupHarness();
});
afterEach(() => teardownHarness());

function names(register: (s: McpServer) => void): string[] {
  const out: string[] = [];
  register({ registerTool: (name: string) => void out.push(name) } as unknown as McpServer);
  return out;
}

const byLabel = (label: string) => ACCOUNTS.find((a) => a.label === label)!;

describe("registration", () => {
  it("full tokens get the Drive, mail and provider tools once each", () => {
    const all = names(registerAllTools);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(expect.arrayContaining(["status", "tree", "undo", "transfer", "cloud_list", "cloud_find", "cloud_read", "cloud_mkdir", "cloud_move", "cloud_rename", "cloud_trash"]));
  });

  it("read-only tokens get the provider read tools only", () => {
    const read = names((s) => registerReadTools(s));
    expect(read).toEqual(expect.arrayContaining(["cloud_list", "cloud_find", "cloud_read", "status", "tree"]));
    expect(read).not.toContain("transfer");
    expect(read).not.toContain("cloud_trash");
  });
});

describe("Google-only tools with a OneDrive or Dropbox label", () => {
  it("list, tree and mail_search explain which tools to use instead", async () => {
    const tools = collect(registerAllTools);
    const list = await call(tools, "list", { account: "work", path: "/" });
    expect(list.isError).toBe(true);
    expect(list.text).toMatch(/"work" is a OneDrive account; this tool works on Google accounts only/);
    expect(list.text).toMatch(/cloud_list/);
    const tree = await call(tools, "tree", { account: "client-a", depth: 1 });
    expect(tree.text).toMatch(/Dropbox account.*transfer/);
    const mail = await call(tools, "mail_search", { account: "client-a", query: "x", limit: 5 });
    expect(mail.isError).toBe(true);
    expect(mail.text).toMatch(/Google accounts only/);
  });

  it("find on one non-Google account is refused; find across all skips them with a note", async () => {
    const tools = collect(registerAllTools);
    const one = await call(tools, "find", { query: "notes", account: "work", limit: 10, foldersOnly: false, includeShared: true });
    expect(one.text).toMatch(/OneDrive account.*cloud_find/);
    const all = await call(tools, "find", { query: "notes", limit: 10, foldersOnly: false, includeShared: true });
    expect(all.isError).toBe(false);
    const skipped = all.json!.skipped as { account: string; provider: string }[];
    expect(skipped.map((s) => s.account).sort()).toEqual(["archive", "client-a", "client-b", "work"]);
    expect(all.json!.partial).toBe(false);
    expect((all.json!.errors as unknown[]).length).toBe(0);
    expect((all.json!.results as { path: string }[]).map((r) => r.path)).toContain("personal:/Projects/notes.txt");
  });
});

describe("accounts tool", () => {
  it("lists Google accounts with storage and other providers with a note, without calling Drive for them", async () => {
    const tools = collect(registerAllTools);
    const r = await call(tools, "accounts", {});
    const rows = r.json!.accounts as Record<string, unknown>[];
    expect(rows).toHaveLength(6);
    expect(rows.find((x) => x.label === "personal")).toMatchObject({ provider: "google", storageUsed: 1, storageQuota: 2 });
    const work = rows.find((x) => x.label === "work")!;
    expect(work).toMatchObject({ provider: "microsoft", mode: "write", gmail: false });
    expect(work.note).toMatch(/cloud_list/);
    expect(work.error).toBeUndefined();
    expect(rows.find((x) => x.label === "archive")).toMatchObject({ provider: "microsoft", mode: "read" });
    expect(rows.find((x) => x.label === "client-a")).toMatchObject({ provider: "dropbox" });
  });
});

describe("instructions", () => {
  it("mention cloud_* and transfer only when a non-Google account is connected", () => {
    const google = [{ label: "personal" }];
    const mixed = [{ label: "personal" }, { label: "work", provider: "microsoft" as const }];
    expect(buildInstructions(google, { full: true })).not.toMatch(/cloud_list|transfer copies/);
    const full = buildInstructions(mixed, { full: true });
    expect(full).toContain("work (OneDrive, beta, no mail)");
    expect(full).toMatch(/cloud_list.*cloud_trash/);
    expect(full).toMatch(/transfer copies or moves/);
    expect(full).toMatch(/status reports token health/);
    expect(full).toMatch(/undo/);
    expect(full).toMatch(/dryRun=true/);
    const read = buildInstructions(mixed, { full: false });
    expect(read).toMatch(/cloud_list, cloud_find and cloud_read/);
    expect(read).not.toMatch(/transfer|cloud_trash/);
  });
});

describe("token check and revocation", () => {
  it("checks OneDrive and Dropbox refresh tokens live", async () => {
    expect(await checkProviderToken(byLabel("work"))).toEqual({ expiresInSec: 3600 });
    expect(await checkProviderToken(byLabel("client-a"))).toEqual({ expiresInSec: 14400 });
    expect(h.ms.log.filter((l) => l.url.includes("/oauth2/v2.0/token"))).toHaveLength(1);
  });

  it("revokes a Dropbox grant with the token it refreshes; Microsoft has no revoke endpoint", async () => {
    const revoked: string[] = [];
    setProviderFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === DROPBOX_REVOKE_URL) {
        revoked.push(String((init?.headers as Record<string, string>).Authorization));
        return new Response("null", { status: 200 });
      }
      return h.dbx.fetchImpl(input, init);
    }) as typeof fetch);
    expect(await revokeDropboxToken("rt-client-a")).toBe(true);
    expect(revoked).toEqual(["Bearer dbx-tok-client-a"]);
    expect(await revokeMicrosoftToken()).toBe(false);
  });
});
