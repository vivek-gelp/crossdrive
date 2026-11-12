import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { readAudit } from "./audit";
import { COPY_RETRY_BACKOFF_MS, copyTree, decodeCursor, MAX_RETRY_ROUNDS, type CopyTreeResult } from "./copytree";
import { FOLDER_MIME, SHORTCUT_MIME } from "./drive";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";
import { registerAllTools, setDriveFetch } from "./tools";

const WORK = "alex@acme.example";
const PERSONAL = "alex.example@gmail.com";
const SPECS = [
  { label: "work", email: WORK },
  { label: "personal", email: PERSONAL },
];

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const { storeMock } = await import("./testing/fakeDrive");
  return {
    ...orig,
    ...storeMock([
      { label: "work", email: "alex@acme.example" },
      { label: "personal", email: "alex.example@gmail.com" },
    ]),
  };
});

type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collectTools(): Record<string, Handler> {
  const tools: Record<string, Handler> = {};
  const server = { registerTool: (name: string, _d: unknown, h: Handler) => void (tools[name] = h) } as unknown as McpServer;
  registerAllTools(server);
  return tools;
}

async function call(tools: Record<string, Handler>, name: string, args: Record<string, unknown>) {
  const r = await tools[name]!(args, {} as ServerContext);
  const textOut = r.content[0]?.text ?? "";
  return { isError: r.isError === true, text: textOut, json: r.isError ? undefined : (JSON.parse(textOut) as Record<string, unknown>) };
}

const GDOC = "application/vnd.google-apps.document";

/**
 * work:/01_Company
 *   2026-01-05_Acme_Report.pdf (10 bytes)
 *   Board notes (Google Doc)
 *   02_Sub/
 *     2026-02-01_Acme_Memo.txt (5 bytes)
 *     Report shortcut -> rep
 *   03_Empty/
 */
function files(): Record<string, FakeFile> {
  const own = [{ emailAddress: WORK }];
  return {
    root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, owners: own },
    co: { id: "co", name: "01_Company", mimeType: FOLDER_MIME, parents: ["root"], owners: own },
    rep: { id: "rep", name: "2026-01-05_Acme_Report.pdf", mimeType: "application/pdf", parents: ["co"], owners: own, size: "10" },
    gdoc: { id: "gdoc", name: "Board notes", mimeType: GDOC, parents: ["co"], owners: own },
    sub: { id: "sub", name: "02_Sub", mimeType: FOLDER_MIME, parents: ["co"], owners: own },
    memo: { id: "memo", name: "2026-02-01_Acme_Memo.txt", mimeType: "text/plain", parents: ["sub"], owners: own, size: "5" },
    sc: { id: "sc", name: "Report shortcut", mimeType: SHORTCUT_MIME, parents: ["sub"], owners: own, shortcutDetails: { targetId: "rep", targetMimeType: "application/pdf" } },
    empty: { id: "empty", name: "03_Empty", mimeType: FOLDER_MIME, parents: ["co"], owners: own },
    proot: { id: "proot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: PERSONAL }] },
    ideas: { id: "ideas", name: "10_Ideas", mimeType: FOLDER_MIME, parents: ["proot"], owners: [{ emailAddress: PERSONAL }] },
  };
}

/** Names of everything below `parentId`, as `path` strings, for structural assertions. */
function tree(all: Record<string, FakeFile>, parentId: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const f of Object.values(all)) {
    if (!f.parents?.includes(parentId) || f.trashed) continue;
    const here = `${prefix}${f.name}${f.mimeType === FOLDER_MIME ? "/" : f.mimeType === SHORTCUT_MIME ? ` -> ${f.shortcutDetails?.targetId}` : ""}`;
    out.push(here, ...tree(all, f.id, `${prefix}${f.name}/`));
  }
  return out.sort();
}

const EXPECTED = [
  "01_Company/",
  "01_Company/02_Sub/",
  "01_Company/02_Sub/2026-02-01_Acme_Memo.txt",
  "01_Company/02_Sub/Report shortcut -> rep",
  "01_Company/03_Empty/",
  "01_Company/2026-01-05_Acme_Report.pdf",
  "01_Company/Board notes",
];

const base = { fromAccount: "work", fileId: "co", toAccount: "personal", toFolderId: "ideas", trashOriginal: false, allowNonStandardName: false, dryRun: false, maxFiles: 150 };

describe("copy of a folder", () => {
  let tools: Record<string, Handler>;
  beforeEach(() => {
    setStore(memoryStore());
    tools = collectTools();
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("dryRun only walks the tree and reports the plan", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { ...base, dryRun: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({
      kind: "folder",
      dryRun: true,
      crossAccount: true,
      source: { id: "co", path: "work:/01_Company" },
      destination: { path: "personal:/10_Ideas/01_Company" },
      files: 3,
      folders: 2,
      shortcuts: 1,
      bytes: 15,
      truncated: false,
      calls: 1,
    });
    expect(b.log.filter((l) => l.method !== "GET")).toHaveLength(0);
    expect(await readAudit(5)).toEqual([]);
  });

  it("copies a whole tree within one account, re-creating shortcuts, without touching permissions", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { ...base, toAccount: "work", toFolderId: "root", newName: "01_Company_Copy" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({
      kind: "folder",
      crossAccount: false,
      done: true,
      copiedFiles: 3,
      createdFolders: 3,
      shortcuts: 1,
      skipped: 0,
      failures: [],
      top: { account: "work", name: "01_Company_Copy", path: "work:/01_Company_Copy" },
    });
    expect(r.json!.resume).toBeUndefined();
    const top = Object.values(b.files).find((f) => f.name === "01_Company_Copy")!;
    expect(tree(b.files, "root").filter((p) => p.startsWith("01_Company_Copy/"))).toEqual(EXPECTED.map((p) => p.replace(/^01_Company\//, "01_Company_Copy/")));
    expect(b.log.some((l) => l.path.includes("/permissions"))).toBe(false);
    const audit = await readAudit(10);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: "copy", account: "work", toAccount: "work", from: "co", fileId: top.id, name: "01_Company_Copy", counts: { copiedFiles: 3, createdFolders: 3, shortcuts: 1, skipped: 0, failed: 0 }, done: true });
  });

  it("refuses to copy a folder into itself or below itself", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const self = await call(tools, "copy", { ...base, toAccount: "work", toFolderId: "co" });
    expect(self.isError).toBe(true);
    expect(self.text).toMatch(/inside itself/);
    const below = await call(tools, "copy", { ...base, toAccount: "work", toFolderId: "sub" });
    expect(below.isError).toBe(true);
    expect(b.log.filter((l) => l.method !== "GET")).toHaveLength(0);
  });

  it("copies across accounts in slices with one temporary reader grant per file: the folder is never shared, nothing lingers between slices", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const first = await call(tools, "copy", { ...base, maxFiles: 2 });
    expect(first.isError, first.text).toBe(false);
    expect(first.json).toMatchObject({ kind: "folder", crossAccount: true, done: false });
    expect(typeof first.json!.resume).toBe("string");
    const cursor = decodeCursor(first.json!.resume as string);
    expect(cursor.share).toBeUndefined();
    expect(cursor.pending.length).toBeGreaterThan(0);
    // Between slices nobody but the owner has access to anything.
    for (const id of Object.keys(b.permissions)) expect(b.permissions[id]!.filter((p) => p.role !== "owner")).toEqual([]);

    let resume = first.json!.resume as string | undefined;
    let calls = 1;
    let last = first.json!;
    while (resume) {
      const next = await call(tools, "copy", { ...base, maxFiles: 2, resume });
      expect(next.isError, next.text).toBe(false);
      last = next.json!;
      resume = next.json!.resume as string | undefined;
      if (++calls > 10) throw new Error("did not finish");
    }
    expect(last.done).toBe(true);
    expect(last.totals).toEqual({ copiedFiles: 3, createdFolders: 3, shortcuts: 1, skipped: 0, failed: 0 });
    expect(calls).toBeGreaterThan(1);
    expect(tree(b.files, "ideas")).toEqual(EXPECTED);
    for (const l of b.log.filter((x) => x.path.endsWith("/copy"))) expect(l.account).toBe("personal");
    // No permission request on any folder; one reader grant per copied file, each removed again.
    const grants = b.log.filter((l) => l.method === "POST" && l.path.endsWith("/permissions"));
    expect(grants.map((g) => g.path).sort()).toEqual(["/drive/v3/files/gdoc/permissions", "/drive/v3/files/memo/permissions", "/drive/v3/files/rep/permissions"]);
    for (const g of grants) {
      expect(g).toMatchObject({ account: "work", body: { type: "user", role: "reader", emailAddress: PERSONAL } });
      expect(typeof (g.body as { expirationTime?: string }).expirationTime).toBe("string");
      expect(g.params.get("sendNotificationEmail")).toBe("false");
    }
    for (const id of ["co", "sub", "empty"]) expect(b.log.some((l) => l.path.startsWith(`/drive/v3/files/${id}/permissions`) && l.method !== "GET")).toBe(false);
    for (const id of ["rep", "gdoc", "memo"]) expect(b.permissions[id]!.map((p) => p.role)).toEqual(["owner"]);
    const audit = await readAudit(50);
    expect(audit.filter((e) => e.tool === "temp_grant")).toHaveLength(3);
    expect(audit.filter((e) => e.tool === "temp_grant_removed")).toHaveLength(3);
    expect(audit.filter((e) => e.tool === "copy")).toHaveLength(calls);
    expect(audit.some((e) => e.tool === "share" || e.tool === "unshare")).toBe(false);
  });

  it("removes the folder-wide writer share a cursor from before 1.0.1 left behind, then continues per file", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const first = await call(tools, "copy", { ...base, maxFiles: 1 });
    const c = decodeCursor(first.json!.resume as string);
    // Simulate an old cursor: a writer share on the top folder.
    (b.permissions.co ??= [{ id: "owner-perm", type: "user", role: "owner", emailAddress: WORK }]).push({ id: "legacy1", type: "user", role: "writer", emailAddress: PERSONAL });
    c.share = { permissionId: "legacy1" };
    c.visible = true;
    const resume = Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
    const next = await call(tools, "copy", { ...base, maxFiles: 150, resume });
    expect(next.isError, next.text).toBe(false);
    expect(next.json!.done).toBe(true);
    expect(b.permissions.co!.map((p) => p.role)).toEqual(["owner"]);
    expect((await readAudit(50)).some((e) => e.tool === "temp_grant_removed" && e.permissionId === "legacy1")).toBe(true);
  });

  it("skips files that already exist at the destination with the same name and size", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const one = await call(tools, "copy", base);
    expect(one.isError, one.text).toBe(false);
    const two = await call(tools, "copy", base);
    expect(two.isError, two.text).toBe(false);
    expect(two.json).toMatchObject({ done: true, copiedFiles: 0, createdFolders: 0, shortcuts: 0, skipped: 4, failures: [] });
    expect(tree(b.files, "ideas")).toEqual(EXPECTED);
  });

  it("reports a permanent per-file failure (403) at once, removes that file's grant and still finishes", async () => {
    const b = fakeDrive(SPECS, files(), { failCopyIds: ["gdoc"], failCopyStatus: 403 });
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", base);
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ done: true, copiedFiles: 2, failed: 1, retrying: [], failures: [{ id: "gdoc", name: "Board notes", error: expect.stringMatching(/cannot be copied/) }] });
    expect(b.log.filter((l) => l.path === "/drive/v3/files/gdoc/copy")).toHaveLength(1);
    // The grant made for the failed file was removed in the finally path, and audited.
    expect(b.permissions.gdoc!.map((p) => p.role)).toEqual(["owner"]);
    const audit = (await readAudit(50)).filter((e) => e.fileId === "gdoc").map((e) => e.tool);
    expect(audit).toEqual(["temp_grant_removed", "temp_grant"]);
  });

  describe("transient failures (cross-account)", () => {
    const meta = { actor: "test" };
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    beforeEach(() => sleeps.splice(0));

    it("retries a 404/5xx with backoff, keeps the file in the cursor, and gives up only after the retry rounds; no grant survives a slice", async () => {
      const b = fakeDrive(SPECS, files(), { failCopyIds: ["gdoc"] }); // 500 on every attempt
      setDriveFetch(b.fetchImpl);
      let r = (await copyTree(base, meta, { sleep })) as CopyTreeResult;
      expect(r).toMatchObject({ done: false, copiedFiles: 2, failed: 0, failures: [], retrying: [{ id: "gdoc", name: "Board notes" }] });
      expect(r.note).toMatch(/transient error/);
      expect(decodeCursor(r.resume!).retry).toEqual([["gdoc", r.top.id, "Board notes", 1]]);
      expect(sleeps.slice(0, COPY_RETRY_BACKOFF_MS.length)).toEqual(COPY_RETRY_BACKOFF_MS);
      expect(b.permissions.gdoc!.map((p) => p.role)).toEqual(["owner"]);
      let rounds = 1;
      while (!r.done) {
        r = (await copyTree({ ...base, resume: r.resume }, meta, { sleep })) as CopyTreeResult;
        rounds++;
        if (rounds > 10) throw new Error("never finished");
      }
      expect(rounds).toBe(MAX_RETRY_ROUNDS + 1);
      expect(r).toMatchObject({ done: true, failed: 1, failures: [{ id: "gdoc", error: expect.stringMatching(/cannot be copied/) }], retrying: [] });
      expect(r.totals).toMatchObject({ copiedFiles: 2, shortcuts: 1, createdFolders: 3, failed: 1 });
      expect(tree(b.files, "ideas")).toEqual(EXPECTED.filter((p) => p !== "01_Company/Board notes"));
      for (const id of Object.keys(b.permissions)) expect(b.permissions[id]!.filter((p) => p.role !== "owner")).toEqual([]);
      const audit = (await readAudit(100)).filter((e) => e.tool === "copy");
      expect(audit[0]!.done).toBe(true);
      expect(audit[audit.length - 1]!.done).toBe(false);
    });
  });

  it("trashOriginal trashes the top folder only once the copy is done", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const first = await call(tools, "copy", { ...base, maxFiles: 2, trashOriginal: true });
    expect(first.isError, first.text).toBe(false);
    expect(first.json!.done).toBe(false);
    expect(b.files.co!.trashed).toBeUndefined();
    let resume = first.json!.resume as string | undefined;
    let last = first.json!;
    for (let guard = 0; resume; guard++) {
      if (guard > 10) throw new Error("did not finish");
      const next = await call(tools, "copy", { ...base, maxFiles: 2, trashOriginal: true, resume });
      expect(next.isError, next.text).toBe(false);
      last = next.json!;
      resume = next.json!.resume as string | undefined;
    }
    expect(last).toMatchObject({ done: true, source: { trashed: true } });
    expect(b.files.co!.trashed).toBe(true);
    for (const id of ["rep", "gdoc", "sub", "memo"]) expect(b.files[id]!.trashed).toBeUndefined();
    expect((await readAudit(1))[0]).toMatchObject({ tool: "trash", fileId: "co" });
  });

  it("refuses a resume cursor for a different copy and view-only sources with trashOriginal", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const first = await call(tools, "copy", { ...base, maxFiles: 1 });
    const bad = await call(tools, "copy", { ...base, fileId: "sub", resume: first.json!.resume });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/resume cursor/);
    const garbage = await call(tools, "copy", { ...base, resume: "nope" });
    expect(garbage.isError).toBe(true);
  });

  it("batch still refuses folders and points at the copy tool", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "batch", { operations: [{ op: "copy", fromAccount: "work", fileId: "co", toAccount: "personal", toFolderId: "ideas" }], dryRun: true, stopOnError: false });
    expect(r.isError, r.text).toBe(false);
    const items = r.json!.items as { status: string; message: string }[];
    expect(items[0]!.status).toBe("error");
    expect(items[0]!.message).toMatch(/copy tool/);
  });
});
