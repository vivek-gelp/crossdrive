import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { FOLDER_MIME } from "./drive";
import { registerAllTools, setDriveFetch } from "./tools";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";

const WORK = "alex@acme.example";
const PERSONAL = "alex.example@gmail.com";

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const { storeMock } = await import("./testing/fakeDrive");
  return {
    ...orig,
    ...storeMock([
      { label: "work", email: "alex@acme.example", drives: [{ id: "d1", name: "Finance" }] },
      { label: "personal", email: "alex.example@gmail.com" },
    ]),
  };
});

type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type ToolDef = { description: string; annotations?: Record<string, boolean> };

function collectTools() {
  const tools: Record<string, Handler> = {};
  const defs: Record<string, ToolDef> = {};
  const server = {
    registerTool(name: string, def: ToolDef, handler: Handler) {
      tools[name] = handler;
      defs[name] = def;
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
    d1: { id: "d1", name: "Finance", mimeType: FOLDER_MIME, driveId: "d1" },
    y26: { id: "y26", name: "2026", mimeType: FOLDER_MIME, parents: ["d1"], driveId: "d1", modifiedTime: "2026-02-01T00:00:00.000Z" },
    inv: { id: "inv", name: "Invoice.pdf", mimeType: "application/pdf", parents: ["y26"], driveId: "d1", modifiedTime: "2026-03-01T00:00:00.000Z", size: "10" },
    proot: { id: "proot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: PERSONAL }] },
  };
}

describe("Shared Drives in the tools", () => {
  let tools: Record<string, Handler>;
  let defs: Record<string, ToolDef>;
  beforeEach(() => {
    setStore(memoryStore());
    ({ tools, defs } = collectTools());
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("drives lists the Shared Drives of an account with a drive/ path, and is read-only", async () => {
    setDriveFetch(fakeDrive([{ label: "work", email: WORK, drives: [{ id: "d1", name: "Finance" }] }, { label: "personal", email: PERSONAL }], files()).fetchImpl);
    const r = await call(tools, "drives", { account: "work" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toEqual({ account: "work", drives: [{ id: "d1", name: "Finance", path: "work:drive/Finance" }] });
    expect(defs.drives?.annotations?.readOnlyHint).toBe(true);
  });

  it("drives returns an empty list, not an error, for an account without Shared Drives", async () => {
    setDriveFetch(fakeDrive([{ label: "work", email: WORK }, { label: "personal", email: PERSONAL }], files()).fetchImpl);
    const r = await call(tools, "drives", { account: "personal" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toEqual({ account: "personal", drives: [] });
  });

  it("list and find work inside a Shared Drive via label:drive/<name>/... paths", async () => {
    const b = fakeDrive([{ label: "work", email: WORK, drives: [{ id: "d1", name: "Finance" }] }, { label: "personal", email: PERSONAL }], files());
    setDriveFetch(b.fetchImpl);
    const root = await call(tools, "list", { account: "work", path: "work:drive/Finance" });
    expect(root.isError, root.text).toBe(false);
    expect(root.json).toMatchObject({ folderId: "d1", path: "work:drive/Finance" });
    expect((root.json!.files as Record<string, unknown>[])[0]).toMatchObject({ name: "2026", path: "work:drive/Finance/2026", owner: "me", canEdit: true });

    const sub = await call(tools, "list", { account: "work", path: "work:drive/finance/2026" });
    expect((sub.json!.files as Record<string, unknown>[])[0]).toMatchObject({ name: "Invoice.pdf", path: "work:drive/Finance/2026/Invoice.pdf" });

    const found = await call(tools, "find", { query: "Invoice", account: "work", path: "work:drive/Finance/2026", limit: 20, includeShared: true, foldersOnly: false });
    expect(found.isError, found.text).toBe(false);
    expect((found.json!.results as Record<string, unknown>[])[0]).toMatchObject({ id: "inv", path: "work:drive/Finance/2026/Invoice.pdf" });
    const q = b.log.filter((l) => l.path === "/drive/v3/files" && l.method === "GET").at(-1)!;
    expect(q.params.get("q")).toContain("'y26' in parents");
    expect(q.params.get("includeItemsFromAllDrives")).toBe("true");
    expect(q.params.get("corpora")).toBe("allDrives");

    const missing = await call(tools, "list", { account: "work", path: "work:drive/Nope" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/"Nope" is not a Shared Drive/);
  });
});
