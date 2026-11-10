import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAudit } from "../audit";
import { accountMode } from "../store";
import { connectCallback, connectStartUrl } from "./connect";
import { headerArg } from "./dropbox";
import { assertGoogleAccount, parseRef, providerFor } from "./index";
import { targetName } from "./names";
import { registerProviderReadTools, registerProviderTools } from "./register";
import { pkceChallenge, verifyProviderState } from "./state";
import { call, collect, setupHarness, teardownHarness, upserts, type Harness } from "./testing/harness";
import { providerAccessToken } from "./tokens";

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

describe("tokens", () => {
  it("refreshes once and caches the access token per account", async () => {
    const { account } = await providerFor("work");
    expect(await providerAccessToken(account)).toBe("ms-tok-work");
    expect(await providerAccessToken(account)).toBe("ms-tok-work");
    expect(h.ms.log.filter((l) => l.url.includes("/oauth2/v2.0/token"))).toHaveLength(1);
    const { account: dbx } = await providerFor("client-a");
    expect(await providerAccessToken(dbx)).toBe("dbx-tok-client-a");
  });

  it("persists a rotated Microsoft refresh token", async () => {
    teardownHarness();
    h = setupHarness({ ms: { rotate: true } });
    const { account } = await providerFor("work");
    await providerAccessToken(account);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ label: "work", provider: "microsoft", refresh_token: "rt-work-2" });
  });

  it("explains missing client configuration", async () => {
    delete process.env.MS_CLIENT_ID;
    const { account } = await providerFor("work");
    await expect(providerAccessToken(account)).rejects.toThrow(/MS_CLIENT_ID/);
  });
});

describe("OneDrive adapter", () => {
  it("follows @odata.nextLink pages and refuses foreign page tokens", async () => {
    teardownHarness();
    h = setupHarness({ ms: { pageSize: 2 } });
    for (const n of ["a", "b", "c"]) h.ms.put("work", `/P/${n}.txt`, n);
    const { provider } = await providerFor("work");
    const folder = await provider.stat("/P");
    const p1 = await provider.list(folder);
    expect(p1.entries.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
    const p2 = await provider.list(folder, p1.nextPageToken);
    expect(p2.entries.map((e) => e.path)).toEqual(["/P/c.txt"]);
    expect(p2.nextPageToken).toBeUndefined();
    await expect(provider.list(folder, "https://evil.example/steal")).rejects.toThrow(/Invalid OneDrive page token/);
  });

  it("mkdir is idempotent, rename never overwrites, trash goes to the recycle bin, downloads drop the bearer token", async () => {
    h.ms.put("work", "/D/x.txt", "x");
    h.ms.put("work", "/D/y.txt", "y");
    const { provider } = await providerFor("work");
    const d = await provider.stat("/D");
    const a = await provider.mkdir(d, "Sub");
    const b = await provider.mkdir(d, "Sub");
    expect(a.id).toBe(b.id);
    const x = await provider.stat("/D/x.txt");
    expect(x.hash?.quickXor).toBeTruthy();
    await expect(provider.rename(x, "y.txt")).rejects.toMatchObject({ status: 409 });
    const dl = await provider.download(x);
    let got = "";
    for await (const c of dl.stream) got += new TextDecoder().decode(c);
    expect(got).toBe("x");
    expect(h.ms.log.find((l) => l.url.startsWith("https://dl.fake-1drv.example/"))?.auth).toBe(false);
    await provider.trash(x);
    expect(h.ms.get("work", "/D/x.txt")).toBeUndefined();
    expect((await provider.find("y.txt", 5)).map((e) => e.name)).toEqual(["y.txt"]);
  });
});

describe("Dropbox adapter", () => {
  it("escapes non-ASCII in Dropbox-API-Arg and pages list_folder", async () => {
    teardownHarness();
    h = setupHarness({ dbx: { pageSize: 1 } });
    expect(headerArg({ path: "/Café ☕" })).toBe('{"path":"/Caf\\u00e9 \\u2615"}');
    h.ms.put("work", "/Out/Café ☕.txt", "coffee");
    h.ms.put("work", "/Out/plain.txt", "plain");
    const { transfer } = await import("./transfer");
    const r = await transfer({ from: "work:/Out", to: "client-a:/", dryRun: false }, { actor: "t" });
    expect(r).toMatchObject({ done: true, totals: { copied: 2, failed: 0 } });
    const { provider } = await providerFor("client-a");
    const folder = await provider.stat("/Out");
    const p1 = await provider.list(folder);
    expect(p1.entries).toHaveLength(1);
    expect(p1.nextPageToken).toBeTruthy();
    const p2 = await provider.list(folder, p1.nextPageToken);
    expect(p2.entries.map((e) => e.name)).toEqual(["plain.txt"]);
  });

  it("maps not_found to 404 and refuses a folder over a file", async () => {
    h.dbx.put("client-a", "/F/file", "x");
    const { provider } = await providerFor("client-a");
    await expect(provider.stat("/nope")).rejects.toMatchObject({ status: 404 });
    await expect(provider.mkdir(await provider.stat("/F"), "file")).rejects.toMatchObject({ status: 409 });
  });
});

describe("names and guards", () => {
  it("renames for the target provider deterministically", () => {
    expect(targetName("microsoft", 'a<b>"c".txt').name).toBe("a_b__c_.txt");
    expect(targetName("microsoft", "report. ").name).toBe("report");
    expect(targetName("microsoft", "~$lock.docx").name).toBe("_$lock.docx");
    expect(targetName("microsoft", "aux").name).toBe("aux_");
    expect(targetName("microsoft", "plain.txt")).toEqual({ name: "plain.txt" });
    expect(targetName("dropbox", "a\\b").name).toBe("a_b");
    expect(targetName("dropbox", "what?.txt").warning).toMatch(/Windows/);
    expect(targetName("google", "a/b:c")).toEqual({ name: "a/b:c" });
  });

  it("assertGoogleAccount points non-Google labels at the generic tools", () => {
    expect(() => assertGoogleAccount({ label: "personal", provider: "google" })).not.toThrow();
    expect(() => assertGoogleAccount({ label: "personal" })).not.toThrow();
    expect(() => assertGoogleAccount({ label: "work", provider: "microsoft" })).toThrow(/OneDrive account.*cloud_list.*transfer/);
  });

  it("parses label:/path references", () => {
    expect(parseRef("client-a:/A/B/")).toEqual({ label: "client-a", path: "/A/B" });
    expect(parseRef("work:")).toEqual({ label: "work", path: "/" });
    expect(() => parseRef("Work:/x")).toThrow(/Invalid account label/);
    expect(() => parseRef("work:/a/../b")).toThrow();
    expect(() => parseRef("/no/label")).toThrow(/label:\/path/);
  });
});

describe("connect flows", () => {
  it("Microsoft: consent URL with PKCE S256, scopes and login_hint; callback stores the account", async () => {
    const url = new URL(await connectStartUrl("microsoft", "work", "admin@example.com"));
    expect(url.origin + url.pathname).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("offline_access Files.ReadWrite.All User.Read");
    expect(url.searchParams.get("login_hint")).toBe("work@example.com");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/connect\/microsoft\/callback$/);
    const state = url.searchParams.get("state")!;
    const st = await verifyProviderState(state, "microsoft");
    expect(pkceChallenge(st.verifier)).toBe(url.searchParams.get("code_challenge"));

    const label = await connectCallback("microsoft", new URLSearchParams({ state, code: "code-work" }), "admin@example.com");
    expect(label).toBe("work");
    // A reconnect goes through connectedAccountRecord: the label keeps its mode (absent on this record, i.e. "write") and gets no mail.
    expect(upserts.at(-1)).toMatchObject({ label: "work", email: "work@example.com", provider: "microsoft", mail: "off", refresh_token: "rt-work" });
    expect(accountMode(upserts.at(-1)!)).toBe("write");
    const tokenCall = h.ms.log.find((l) => l.url.endsWith("/token"));
    expect(tokenCall).toBeTruthy();
  });

  it("Dropbox: offline access, PKCE; refuses another admin's state and a label held by another provider", async () => {
    const url = new URL(await connectStartUrl("dropbox", "client-a", "admin@example.com"));
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    const state = url.searchParams.get("state")!;
    await expect(connectCallback("dropbox", new URLSearchParams({ state, code: "code-client-a" }), "other@example.com")).rejects.toThrow(/different admin/);
    await expect(connectCallback("microsoft", new URLSearchParams({ state, code: "x" }), "admin@example.com")).rejects.toThrow(/Invalid or expired state/);
    expect(await connectCallback("dropbox", new URLSearchParams({ state, code: "code-client-a" }), "admin@example.com")).toBe("client-a");
    expect(upserts.at(-1)).toMatchObject({ label: "client-a", provider: "dropbox", email: "client-a@example.com" });
    await expect(connectStartUrl("dropbox", "personal", "admin@example.com")).rejects.toThrow(/already used by a Google Drive account/);
    await expect(connectStartUrl("dropbox", "Bad_Label", "admin@example.com")).rejects.toThrow(/label must match/);
  });
});

describe("tools", () => {
  it("read-only registration gets only the read tools", () => {
    expect(Object.keys(collect((s) => registerProviderReadTools(s))).sort()).toEqual(["cloud_find", "cloud_list", "cloud_read"]);
    expect(Object.keys(collect((s) => registerProviderTools(s, { full: false }))).sort()).toEqual(["cloud_find", "cloud_list", "cloud_read"]);
    expect(Object.keys(collect((s) => registerProviderTools(s, { full: true }))).sort()).toEqual([
      "cloud_find",
      "cloud_list",
      "cloud_mkdir",
      "cloud_move",
      "cloud_read",
      "cloud_rename",
      "cloud_trash",
      "transfer",
    ]);
  });

  it("browse, read, mkdir, move, rename and trash on Dropbox and OneDrive, with audit", async () => {
    const tools = collect((s) => registerProviderTools(s, { full: true, actor: () => "tester" }));
    h.dbx.put("client-a", "/Notes/todo.md", "- ship it");
    h.dbx.put("client-a", "/Notes/photo.jpg", "binary");

    const list = await call(tools, "cloud_list", { path: "client-a:/Notes" });
    expect((list.json!.entries as { path: string }[]).map((e) => e.path)).toEqual(["client-a:/Notes/photo.jpg", "client-a:/Notes/todo.md"]);
    const read = await call(tools, "cloud_read", { path: "client-a:/Notes/todo.md", maxBytes: 4 });
    expect(read.json).toMatchObject({ text: "- sh", truncated: true });
    expect((await call(tools, "cloud_read", { path: "client-a:/Notes/photo.jpg", maxBytes: 100 })).text).toMatch(/plain-text files only/);

    const mk = await call(tools, "cloud_mkdir", { path: "client-a:/Archive/2026" });
    expect(mk.json!.created).toEqual(["client-a:/Archive", "client-a:/Archive/2026"]);
    expect((await call(tools, "cloud_move", { path: "client-a:/Notes/todo.md", toFolder: "client-a:/Archive/2026" })).json).toMatchObject({ path: "client-a:/Archive/2026/todo.md" });
    expect((await call(tools, "cloud_move", { path: "client-a:/Notes/photo.jpg", toFolder: "work:/" })).text).toMatch(/use transfer/);
    // The naming rule is opt-in (VAULT_NAMING_RULE=date-entity); with it on, a free-form name needs allowNonStandardName.
    process.env.VAULT_NAMING_RULE = "date-entity";
    try {
      expect((await call(tools, "cloud_rename", { path: "client-a:/Notes/photo.jpg", newName: "cover.jpg" })).text).toMatch(/naming rule/);
      expect((await call(tools, "cloud_rename", { path: "client-a:/Notes/photo.jpg", newName: "cover.jpg", allowNonStandardName: true })).json).toMatchObject({ name: "cover.jpg" });
    } finally {
      delete process.env.VAULT_NAMING_RULE;
    }
    expect((await call(tools, "cloud_trash", { path: "client-a:/Notes/cover.jpg" })).json).toMatchObject({ trashed: true });
    expect(h.dbx.get("client-a", "/Notes/cover.jpg")).toBeUndefined();

    const audit = (await readAudit(50)).map((e) => e.tool).sort();
    expect(audit).toEqual(["cloud_mkdir", "cloud_mkdir", "cloud_move", "cloud_rename", "cloud_trash"]);
  });

  it("refuses writes on a read-mode account and finds across all accounts", async () => {
    const tools = collect((s) => registerProviderTools(s, { full: true, actor: () => "tester" }));
    h.ms.put("archive", "/Old/report.txt", "r");
    h.dbx.put("client-b", "/report-final.txt", "r");
    expect((await call(tools, "cloud_trash", { path: "archive:/Old/report.txt" })).text).toMatch(/read-only/);
    expect((await call(tools, "cloud_mkdir", { path: "archive:/New" })).text).toMatch(/read-only/);
    const found = await call(tools, "cloud_find", { query: "report", limit: 10, account: undefined });
    const paths = (found.json!.results as { path: string }[]).map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["archive:/Old/report.txt", "client-b:/report-final.txt"]));
  });

  it("transfer tool: dry run plan, then a real run", async () => {
    const tools = collect((s) => registerProviderTools(s, { full: true, actor: () => "tester" }));
    h.dbx.put("client-a", "/T/a.txt", "a");
    h.ms.put("work", "/In");
    const plan = await call(tools, "transfer", { from: "client-a:/T", to: "work:/In", move: false, dryRun: true, maxFiles: 200 });
    expect(plan.json).toMatchObject({ dryRun: true, files: 1, folders: 1 });
    expect(h.ms.get("work", "/In/T")).toBeUndefined();
    const real = await call(tools, "transfer", { from: "client-a:/T", to: "work:/In", move: false, dryRun: false, maxFiles: 200 });
    expect(real.json).toMatchObject({ done: true, totals: { copied: 1 } });
    expect((await readAudit(10)).some((e) => e.tool === "transfer" && e.actor === "tester")).toBe(true);
  });
});
