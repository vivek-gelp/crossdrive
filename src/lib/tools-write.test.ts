import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { FOLDER_MIME, type DriveFile } from "./drive";
import { registerAllTools, setDriveFetch } from "./tools";
import { setStore, type TextStore } from "./store";
import { readAudit } from "./audit";

const ME = "alex@acme.example";
const TEAM = "team@acme.example";

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  // vi.mock factories are hoisted, so no reference to module-level constants here.
  const account = { label: "work", email: "alex@acme.example", refresh_token: "r", connectedAt: "2026-01-01T00:00:00Z" };
  return {
    ...orig,
    accessTokenFor: async () => "tok",
    getAccount: async (label: string) => {
      if (label !== "work") throw new Error(`No connected account labelled "${label}"`);
      return account;
    },
    loadAccounts: async () => [account],
  };
});

function memoryStore(): TextStore {
  const data = new Map<string, string>();
  return {
    kind: "memory",
    read: async (p) => data.get(p) ?? null,
    write: async (p, t) => void data.set(p, t),
    listPaths: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)).sort(),
  };
}

type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collectTools(): Record<string, Handler> {
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool(name: string, _def: unknown, handler: Handler) {
      tools[name] = handler;
    },
  } as unknown as McpServer;
  registerAllTools(server);
  return tools;
}

async function call(tools: Record<string, Handler>, name: string, args: Record<string, unknown>) {
  const r = await tools[name]!(args, {} as ServerContext);
  const textOut = r.content[0]?.text ?? "";
  return { isError: r.isError === true, text: textOut, json: r.isError ? undefined : (JSON.parse(textOut) as Record<string, unknown>) };
}

/**
 * Fake Drive backend. Shared-with-me tree owned by TEAM:
 *   Northwind Phase I - All Details (editable)  -> Land -> Survey.pdf
 *   Proposals (view-only)                        -> Draft.docx (view-only)
 * Plus My Drive root with 01_Company.
 */
function backend(opts: { movePatchStatus?: number } = {}) {
  const caps = (edit: boolean) => ({ canEdit: edit, canAddChildren: edit });
  const files: Record<string, DriveFile> = {
    root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: ME }], capabilities: caps(true) },
    co: { id: "co", name: "01_Company", mimeType: FOLDER_MIME, parents: ["root"], owners: [{ emailAddress: ME }], capabilities: caps(true) },
    top1: { id: "top1", name: "Northwind Phase I - All Details", mimeType: FOLDER_MIME, owners: [{ emailAddress: TEAM }], capabilities: caps(true), shared: true },
    land: { id: "land", name: "Land", mimeType: FOLDER_MIME, parents: ["top1"], owners: [{ emailAddress: TEAM }], capabilities: caps(true), shared: true },
    survey: { id: "survey", name: "Survey.pdf", mimeType: "application/pdf", parents: ["land"], owners: [{ emailAddress: TEAM }], capabilities: caps(true), shared: true },
    props: { id: "props", name: "Proposals", mimeType: FOLDER_MIME, owners: [{ emailAddress: TEAM }], capabilities: caps(false), shared: true },
    draft: { id: "draft", name: "Draft.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", parents: ["props"], owners: [{ emailAddress: TEAM }], capabilities: caps(false), shared: true },
  };
  const patches: { id: string; body: Record<string, unknown>; query: URLSearchParams }[] = [];
  const posts: { path: string; body: string }[] = [];
  const queries: string[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.pathname === "/drive/v3/about") return json({ user: { emailAddress: ME.toUpperCase() } });
    if (url.pathname === "/drive/v3/files/root") return json({ id: "root" });
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      queries.push(q);
      let out: DriveFile[] = [];
      if (q.includes("sharedWithMe = true")) {
        out = [files.top1!, files.props!];
        if (q.includes(`mimeType = '${FOLDER_MIME}'`)) out = out.filter((f) => f.mimeType === FOLDER_MIME);
        const m = /name contains '([^']*)'/.exec(q);
        if (m) out = out.filter((f) => f.name.toLowerCase().includes(m[1]!.toLowerCase()));
      } else {
        const m = /'([^']+)' in parents/.exec(q);
        if (m) out = Object.values(files).filter((f) => f.parents?.[0] === m[1]);
        const eq = /name = '([^']*)'/.exec(q);
        if (eq) out = out.filter((f) => f.name === eq[1]);
        if (q.includes(`mimeType = '${FOLDER_MIME}'`)) out = out.filter((f) => f.mimeType === FOLDER_MIME);
        if (q.includes("fullText contains")) out = [files.top1!, files.survey!, files.co!];
      }
      return json({ files: out });
    }
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { name: string; parents: string[] };
      posts.push({ path: url.pathname, body: String(init?.body) });
      return json({ id: "new", name: body.name, mimeType: FOLDER_MIME, parents: body.parents, owners: [{ emailAddress: ME }], capabilities: caps(true) });
    }
    const idMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]!);
      const f = files[id];
      if (!f) return json({ error: { message: "File not found: " + id } }, 404);
      if (method === "PATCH") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        patches.push({ id, body, query: url.searchParams });
        if (url.searchParams.has("addParents") && opts.movePatchStatus) {
          return json({ error: { message: "The user does not have sufficient permissions for this file." } }, opts.movePatchStatus);
        }
        const updated: DriveFile = { ...f, ...(typeof body.name === "string" ? { name: body.name } : {}) };
        if (url.searchParams.has("addParents")) updated.parents = [url.searchParams.get("addParents")!];
        if (typeof body.trashed === "boolean") updated.trashed = body.trashed;
        files[id] = updated;
        return json(updated);
      }
      return json(f);
    }
    return json({ error: { message: `unexpected ${method} ${url.pathname}` } }, 500);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, patches, posts, queries, files };
}

describe("tools on shared-with-me content", () => {
  let tools: Record<string, Handler>;
  beforeEach(() => {
    setStore(memoryStore());
    tools = collectTools();
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("shared lists what is shared with the account, newest first, with owner and capabilities", async () => {
    const b = backend();
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "shared", { account: "work", foldersOnly: false });
    expect(r.isError).toBe(false);
    const files = r.json!.files as Record<string, unknown>[];
    expect(files.map((f) => f.name)).toEqual(["Northwind Phase I - All Details", "Proposals"]);
    expect(files[0]).toMatchObject({ owner: TEAM, shared: true, canEdit: true, path: "work:~shared/Northwind Phase I - All Details" });
    expect(files[1]).toMatchObject({ owner: TEAM, shared: true, canEdit: false });
    expect(b.queries[0]).toContain("sharedWithMe = true");

    const folders = await call(tools, "shared", { account: "work", foldersOnly: true, query: "north" });
    expect((folders.json!.files as unknown[]).length).toBe(1);
  });

  it("list browses into a shared folder by ~shared path and by id", async () => {
    const b = backend();
    setDriveFetch(b.fetchImpl);
    const byPath = await call(tools, "list", { account: "work", path: "work:~shared/Northwind Phase I - All Details" });
    expect(byPath.isError).toBe(false);
    expect(byPath.json).toMatchObject({ folderId: "top1", path: "work:~shared/Northwind Phase I - All Details" });
    expect((byPath.json!.files as Record<string, unknown>[])[0]).toMatchObject({
      name: "Land",
      path: "work:~shared/Northwind Phase I - All Details/Land",
      owner: TEAM,
      shared: true,
      canEdit: true,
    });
    const byId = await call(tools, "list", { account: "work", folderId: "land" });
    expect((byId.json!.files as Record<string, unknown>[])[0]).toMatchObject({ name: "Survey.pdf", path: "work:~shared/Northwind Phase I - All Details/Land/Survey.pdf" });
    const sharedRoot = await call(tools, "list", { account: "work", path: "work:~shared" });
    expect((sharedRoot.json!.files as unknown[]).length).toBe(2);
    expect(sharedRoot.json!.path).toBe("work:~shared");
  });

  it("find returns folders and shared items, and can be scoped to a shared folder", async () => {
    const b = backend();
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "find", { query: "Northwind", account: "work", limit: 20, includeShared: true, foldersOnly: false });
    expect(r.isError).toBe(false);
    const results = r.json!.results as Record<string, unknown>[];
    expect(results.some((x) => x.mimeType === FOLDER_MIME && x.shared === true)).toBe(true);
    expect(b.queries.at(-1)).not.toContain("mimeType");
    expect(b.queries.at(-1)).not.toContain("owners");

    const scoped = await call(tools, "find", { query: "Survey", account: "work", path: "work:~shared/Northwind Phase I - All Details/Land", limit: 20, includeShared: true, foldersOnly: false });
    expect(scoped.isError).toBe(false);
    expect(b.queries.at(-1)).toContain("'land' in parents");

    await call(tools, "find", { query: "x", account: "work", limit: 20, includeShared: false, foldersOnly: true });
    expect(b.queries.at(-1)).toContain("'me' in owners");
    expect(b.queries.at(-1)).toContain(`mimeType = '${FOLDER_MIME}'`);
  });

  it("renames and moves a shared file when the account is an editor, with supportsAllDrives", async () => {
    const b = backend();
    setDriveFetch(b.fetchImpl);
    const renamed = await call(tools, "rename", { account: "work", fileId: "survey", newName: "2026-11-09_Acme_Survey.pdf", allowNonStandardName: false });
    expect(renamed.isError, renamed.text).toBe(false);
    expect(renamed.json).toMatchObject({ name: "2026-11-09_Acme_Survey.pdf", owner: TEAM, shared: true, canEdit: true });
    expect(b.patches[0]).toMatchObject({ id: "survey", body: { name: "2026-11-09_Acme_Survey.pdf" } });

    const moved = await call(tools, "move", { account: "work", fileId: "survey", toPath: "work:~shared/Northwind Phase I - All Details" });
    expect(moved.isError, moved.text).toBe(false);
    expect(moved.json).toMatchObject({ path: "work:~shared/Northwind Phase I - All Details/2026-11-09_Acme_Survey.pdf" });
    const mv = b.patches[1]!;
    expect(mv.query.get("addParents")).toBe("top1");
    expect(mv.query.get("removeParents")).toBe("land");
    expect(mv.query.get("supportsAllDrives")).toBe("true");

    const audit = await readAudit(10);
    expect(audit.map((e) => [e.tool, e.owner])).toEqual([
      ["move", TEAM],
      ["rename", TEAM],
    ]);
  });

  it("refuses writes on view-only shared items with a clear message and never calls Drive", async () => {
    const b = backend();
    setDriveFetch(b.fetchImpl);
    const msg = `view-only: you cannot modify Draft.docx (owner ${TEAM}). Ask the owner to grant Editor or transfer ownership.`;
    const renamed = await call(tools, "rename", { account: "work", fileId: "draft", newName: "x.docx", allowNonStandardName: true });
    expect(renamed).toMatchObject({ isError: true, text: msg });
    const trashed = await call(tools, "trash", { account: "work", fileId: "draft" });
    expect(trashed).toMatchObject({ isError: true, text: msg });
    const moved = await call(tools, "move", { account: "work", fileId: "draft", toFolderId: "co" });
    expect(moved).toMatchObject({ isError: true, text: msg });
    const put = await call(tools, "put", { account: "work", folderId: "props", name: "2026-11-09_Acme_Note.md", content: "hi", mimeType: "text/markdown", allowNonStandardName: false });
    expect(put.isError).toBe(true);
    expect(put.text).toMatch(/^view-only: you cannot modify Proposals \(owner team@acme.example\)/);
    const mk = await call(tools, "mkdir", { account: "work", parentPath: "work:~shared/Proposals", name: "New" });
    expect(mk.isError).toBe(true);
    expect(mk.text).toMatch(/^view-only: you cannot modify Proposals/);
    // Moving an editable file INTO a view-only folder is blocked on the destination.
    const into = await call(tools, "move", { account: "work", fileId: "survey", toFolderId: "props" });
    expect(into.text).toMatch(/^view-only: you cannot modify Proposals/);
    expect(b.patches).toHaveLength(0);
    expect(b.posts).toHaveLength(0);
    expect(await readAudit(10)).toEqual([]);
  });

  it("surfaces Drive's own error text when a permitted move is still refused", async () => {
    const b = backend({ movePatchStatus: 403 });
    setDriveFetch(b.fetchImpl);
    const moved = await call(tools, "move", { account: "work", fileId: "survey", toFolderId: "co" });
    expect(moved.isError).toBe(true);
    expect(moved.text).toContain("Survey.pdf");
    expect(moved.text).toContain("does not have sufficient permissions");
  });

  it("mkdir inside an editable shared folder works and records the owner", async () => {
    const b = backend();
    setDriveFetch(b.fetchImpl);
    const mk = await call(tools, "mkdir", { account: "work", parentPath: "work:~shared/Northwind Phase I - All Details/Land", name: "Maps" });
    expect(mk.isError, mk.text).toBe(false);
    expect(mk.json).toMatchObject({ created: true, path: "work:~shared/Northwind Phase I - All Details/Land/Maps" });
    expect(b.posts).toHaveLength(1);
    expect((await readAudit(10))[0]).toMatchObject({ tool: "mkdir", owner: "me", to: "land" });
  });
});
