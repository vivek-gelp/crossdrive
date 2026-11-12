import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { FOLDER_MIME } from "./drive";
import { registerAllTools, setDriveFetch } from "./tools";
import { setStore } from "./store";
import { readAudit } from "./audit";
import { MAX_BATCH_OPS, previewBatch } from "./batch";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";

const WORK = "alex@acme.example";
const PERSONAL = "alex.example@gmail.com";
const TEAM = "team@acme.example";
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
type Item = { index: number; op: string; status: string; message: string; before?: Record<string, unknown>; after?: Record<string, unknown> };

function collectTools() {
  const tools: Record<string, Handler> = {};
  const defs: Record<string, { annotations?: Record<string, boolean> }> = {};
  const server = {
    registerTool: (name: string, d: { annotations?: Record<string, boolean> }, h: Handler) => {
      tools[name] = h;
      defs[name] = d;
    },
  } as unknown as McpServer;
  registerAllTools(server);
  return { tools, defs };
}

async function call(tools: Record<string, Handler>, name: string, args: Record<string, unknown>) {
  const r = await tools[name]!(args, {} as ServerContext);
  const textOut = r.content[0]?.text ?? "";
  return { isError: r.isError === true, text: textOut, json: r.isError ? undefined : (JSON.parse(textOut) as Record<string, unknown>) };
}

function files(): Record<string, FakeFile> {
  return {
    root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: WORK }] },
    co: { id: "co", name: "01_Company", mimeType: FOLDER_MIME, parents: ["root"], owners: [{ emailAddress: WORK }] },
    inbox: { id: "inbox", name: "99_Inbox_To_File", mimeType: FOLDER_MIME, parents: ["root"], owners: [{ emailAddress: WORK }] },
    a: { id: "a", name: "scan.pdf", mimeType: "application/pdf", parents: ["inbox"], owners: [{ emailAddress: WORK }], size: "5" },
    b: { id: "b", name: "2026-01-02_Acme_Deck.pdf", mimeType: "application/pdf", parents: ["inbox"], owners: [{ emailAddress: WORK }], size: "5" },
    ro: { id: "ro", name: "Plan.docx", mimeType: "application/msword", owners: [{ emailAddress: TEAM }], perms: { [WORK]: "reader" }, sharedWithMe: true },
    proot: { id: "proot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: PERSONAL }] },
    ideas: { id: "ideas", name: "10_Ideas", mimeType: FOLDER_MIME, parents: ["proot"], owners: [{ emailAddress: PERSONAL }] },
  };
}

const ops = () => [
  { op: "rename", account: "work", fileId: "a", newName: "2026-01-01_Acme_Scan.pdf", allowNonStandardName: false },
  { op: "move", account: "work", fileId: "a", toPath: "work:/01_Company" },
  { op: "mkdir", account: "work", parentPath: "work:/01_Company", name: "Board" },
  { op: "copy", fromAccount: "work", fileId: "b", toAccount: "personal", toFolderId: "ideas", allowNonStandardName: false, trashOriginal: false },
  { op: "trash", account: "work", fileId: "ro" },
  { op: "mkdir", account: "work", parentPath: "work:/Nope", name: "X" },
  { op: "trash", account: "work", fileId: "b" },
];

describe("batch", () => {
  let tools: Record<string, Handler>;
  let defs: Record<string, { annotations?: Record<string, boolean> }>;
  beforeEach(() => {
    setStore(memoryStore());
    ({ tools, defs } = collectTools());
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("dryRun previews every operation (ready/error) without changing anything or writing audit entries", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "batch", { operations: ops(), dryRun: true, stopOnError: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.json!.dryRun).toBe(true);
    const items = r.json!.items as Item[];
    expect(items.map((i) => [i.index, i.op, i.status])).toEqual([
      [0, "rename", "ready"],
      [1, "move", "ready"],
      [2, "mkdir", "ready"],
      [3, "copy", "ready"],
      [4, "trash", "error"],
      [5, "mkdir", "error"],
      [6, "trash", "ready"],
    ]);
    expect(items[0]).toMatchObject({ before: { id: "a", name: "scan.pdf", path: "work:/99_Inbox_To_File/scan.pdf", canEdit: true, owner: "me" }, after: { name: "2026-01-01_Acme_Scan.pdf" } });
    expect(items[1]).toMatchObject({ after: { path: "work:/01_Company/scan.pdf", folderId: "co" } });
    expect(items[2]).toMatchObject({ after: { path: "work:/01_Company/Board", exists: false } });
    expect(items[3]).toMatchObject({ message: expect.stringContaining("cross-account"), before: { account: "work", id: "b" }, after: { account: "personal", path: "personal:/10_Ideas/2026-01-02_Acme_Deck.pdf" } });
    expect(items[4]!.message).toMatch(/^view-only: you cannot modify Plan.docx/);
    expect(items[5]!.message).toMatch(/Folder "Nope" not found/);
    expect(r.json!.summary).toEqual({ total: 7, ready: 5, error: 2, ok: 0, skipped: 0, mutations: { move: 1, rename: 1, trash: 1, copy: 1, mkdir: 1, total: 5 } });
    expect(b.log.filter((l) => l.method !== "GET")).toHaveLength(0);
    expect(b.files.a!.name).toBe("scan.pdf");
    expect(await readAudit(10)).toEqual([]);
  });

  it("dryRun=false executes sequentially, reports per item and audits each op with one batchId", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "batch", { operations: ops(), dryRun: false, stopOnError: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.json!.dryRun).toBe(false);
    expect(typeof r.json!.batchId).toBe("string");
    const items = r.json!.items as Item[];
    expect(items.map((i) => i.status)).toEqual(["ok", "ok", "ok", "ok", "error", "error", "ok"]);
    expect(items[0]).toMatchObject({ message: "renamed scan.pdf to 2026-01-01_Acme_Scan.pdf", after: { name: "2026-01-01_Acme_Scan.pdf" } });
    expect(items[1]).toMatchObject({ before: { name: "2026-01-01_Acme_Scan.pdf", path: "work:/99_Inbox_To_File/2026-01-01_Acme_Scan.pdf" }, after: { path: "work:/01_Company/2026-01-01_Acme_Scan.pdf" } });
    expect(items[2]).toMatchObject({ after: { created: true, path: "work:/01_Company/Board" } });
    expect(items[3]).toMatchObject({ after: { account: "personal", path: "personal:/10_Ideas/2026-01-02_Acme_Deck.pdf" } });
    expect(items[6]).toMatchObject({ after: { id: "b", trashed: true } });
    expect(b.files.a).toMatchObject({ name: "2026-01-01_Acme_Scan.pdf", parents: ["co"] });
    expect(b.files.b!.trashed).toBe(true);
    expect(r.json!.summary).toEqual({ total: 7, ok: 5, error: 2, ready: 0, skipped: 0, mutations: { move: 1, rename: 1, trash: 1, copy: 1, mkdir: 1, total: 5 } });
    const audit = await readAudit(20);
    // The cross-account copy adds its temporary grant and its removal.
    expect(audit.map((e) => e.tool)).toEqual(["trash", "copy", "temp_grant_removed", "temp_grant", "mkdir", "move", "rename"]);
    expect(new Set(audit.map((e) => e.batchId))).toEqual(new Set([r.json!.batchId]));
    expect(defs.batch?.annotations?.destructiveHint).toBe(true);
  });

  it("stopOnError skips the remaining operations after the first failure", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "batch", { operations: ops(), dryRun: false, stopOnError: true });
    const items = r.json!.items as Item[];
    expect(items.map((i) => i.status)).toEqual(["ok", "ok", "ok", "ok", "error", "skipped", "skipped"]);
    expect(items[6]!.message).toMatch(/skipped/);
    expect(b.files.b!.trashed).toBeUndefined();
    expect(r.json!.summary).toMatchObject({ ok: 4, error: 1, skipped: 2 });
  });

  it("rejects empty and oversized batches", async () => {
    expect(MAX_BATCH_OPS).toBe(100);
    await expect(previewBatch([])).rejects.toThrow(/empty/);
    const many = Array.from({ length: 101 }, () => ({ op: "trash", account: "work", fileId: "a" }) as const);
    await expect(previewBatch([...many])).rejects.toThrow(/maximum is 100/);
  });
});
