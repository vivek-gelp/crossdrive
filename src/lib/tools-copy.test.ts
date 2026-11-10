import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { FOLDER_MIME } from "./drive";
import { registerAllTools, setDriveFetch } from "./tools";
import { setStore } from "./store";
import { readAudit } from "./audit";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";


// These tests exercise the optional naming rule (VAULT_NAMING_RULE=date-entity).
process.env.VAULT_NAMING_RULE = "date-entity";
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

function files(): Record<string, FakeFile> {
  const sdoc = "application/vnd.google-apps.document";
  return {
    root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: WORK }] },
    co: { id: "co", name: "01_Company", mimeType: FOLDER_MIME, parents: ["root"], owners: [{ emailAddress: WORK }] },
    rep: { id: "rep", name: "2026-01-05_Acme_Report.pdf", mimeType: "application/pdf", parents: ["co"], owners: [{ emailAddress: WORK }], size: "10" },
    gdoc: { id: "gdoc", name: "Board notes", mimeType: sdoc, parents: ["co"], owners: [{ emailAddress: WORK }] },
    // Shared with work by TEAM, view-only.
    ro: { id: "ro", name: "Plan.docx", mimeType: "application/msword", owners: [{ emailAddress: TEAM }], perms: { [WORK]: "reader" }, sharedWithMe: true },
    proot: { id: "proot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: PERSONAL }] },
    ideas: { id: "ideas", name: "10_Ideas", mimeType: FOLDER_MIME, parents: ["proot"], owners: [{ emailAddress: PERSONAL }] },
  };
}

describe("copy", () => {
  let tools: Record<string, Handler>;
  beforeEach(() => {
    setStore(memoryStore());
    tools = collectTools();
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("copies within one account with files.copy and no permission changes", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { fromAccount: "work", fileId: "rep", toAccount: "work", toPath: "work:/", trashOriginal: false, allowNonStandardName: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({
      crossAccount: false,
      source: { id: "rep", path: "work:/01_Company/2026-01-05_Acme_Report.pdf", trashed: false },
      copy: { name: "2026-01-05_Acme_Report.pdf", path: "work:/2026-01-05_Acme_Report.pdf", account: "work", owner: "me" },
    });
    const copyReq = b.log.find((l) => l.path === "/drive/v3/files/rep/copy")!;
    expect(copyReq).toMatchObject({ account: "work", body: { name: "2026-01-05_Acme_Report.pdf", parents: ["root"] } });
    expect(copyReq.params.get("supportsAllDrives")).toBe("true");
    expect(b.log.some((l) => l.path.includes("/permissions"))).toBe(false);
    expect((await readAudit(5))[0]).toMatchObject({ tool: "copy", account: "work", toAccount: "work", from: "rep", to: "root", owner: "me" });
  });

  it("copies across accounts via a temporary writer permission that is removed afterwards", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { fromAccount: "work", fileId: "gdoc", toAccount: "personal", toPath: "personal:/10_Ideas", trashOriginal: false, allowNonStandardName: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({
      crossAccount: true,
      copy: { account: "personal", name: "Board notes", mimeType: "application/vnd.google-apps.document", path: "personal:/10_Ideas/Board notes", owner: "me" },
    });
    const steps = b.log.filter((l) => l.path.startsWith("/drive/v3/files/gdoc/") ).map((l) => `${l.account} ${l.method} ${l.path}`);
    const grant = b.log.find((l) => l.method === "POST" && l.path === "/drive/v3/files/gdoc/permissions")!;
    expect(grant).toMatchObject({ account: "work", body: { type: "user", role: "writer", emailAddress: PERSONAL } });
    expect(grant.params.get("sendNotificationEmail")).toBe("false");
    const copyReq = b.log.find((l) => l.path === "/drive/v3/files/gdoc/copy")!;
    expect(copyReq).toMatchObject({ account: "personal", body: { name: "Board notes", parents: ["ideas"] } });
    const revoke = b.log.find((l) => l.method === "DELETE")!;
    expect(revoke.account).toBe("work");
    expect(revoke.path).toMatch(/^\/drive\/v3\/files\/gdoc\/permissions\/perm\d+$/);
    expect(steps.indexOf(`work POST /drive/v3/files/gdoc/permissions`)).toBeLessThan(steps.indexOf(`personal POST /drive/v3/files/gdoc/copy`));
    expect(steps.indexOf(`personal POST /drive/v3/files/gdoc/copy`)).toBeLessThan(steps.findIndex((s) => s.startsWith("work DELETE")));
    // The temporary permission is gone; only the owner remains.
    expect(b.permissions.gdoc!.map((p) => p.role)).toEqual(["owner"]);
    expect((await readAudit(5))[0]).toMatchObject({ tool: "copy", account: "work", toAccount: "personal", from: "gdoc", to: "ideas" });
  });

  it("leaves an existing permission of the destination account untouched", async () => {
    const f = files();
    f.rep!.perms = { [PERSONAL]: "reader" };
    const b = fakeDrive(SPECS, f);
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { fromAccount: "work", fileId: "rep", toAccount: "personal", toFolderId: "ideas", trashOriginal: false, allowNonStandardName: false });
    expect(r.isError, r.text).toBe(false);
    expect(b.log.filter((l) => l.path.includes("/permissions") && l.method !== "GET")).toHaveLength(0);
  });

  it("hands folders to the recursive copier (see tools-copy-folder.test.ts) and rejects resume/dryRun for files", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { fromAccount: "work", fileId: "co", toAccount: "personal", toFolderId: "ideas", trashOriginal: false, allowNonStandardName: false, dryRun: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ kind: "folder", dryRun: true, files: 2 });
    const bad = await call(tools, "copy", { fromAccount: "work", fileId: "rep", toAccount: "personal", toFolderId: "ideas", trashOriginal: false, allowNonStandardName: false, resume: "x" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/folder copies only/);
  });

  it("trashOriginal trashes the source after the copy and audits both; refused for view-only sources", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const ok = await call(tools, "copy", { fromAccount: "work", fileId: "rep", toAccount: "personal", toFolderId: "ideas", trashOriginal: true, allowNonStandardName: false });
    expect(ok.isError, ok.text).toBe(false);
    expect((ok.json!.source as Record<string, unknown>).trashed).toBe(true);
    expect(b.files.rep!.trashed).toBe(true);
    expect((await readAudit(5)).map((e) => e.tool)).toEqual(["trash", "copy"]);

    const ro = await call(tools, "copy", { fromAccount: "work", fileId: "ro", toAccount: "personal", toFolderId: "ideas", trashOriginal: true, allowNonStandardName: false });
    expect(ro.isError).toBe(true);
    expect(ro.text).toMatch(/^view-only: you cannot modify Plan.docx/);
    expect(b.log.some((l) => l.path === "/drive/v3/files/ro/copy")).toBe(false);
  });

  it("applies the naming rule to newName unless allowNonStandardName", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const bad = await call(tools, "copy", { fromAccount: "work", fileId: "rep", toAccount: "work", toFolderId: "root", newName: "report copy.pdf", trashOriginal: false, allowNonStandardName: false });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/naming rule/);
    const good = await call(tools, "copy", { fromAccount: "work", fileId: "rep", toAccount: "work", toFolderId: "root", newName: "report copy.pdf", trashOriginal: false, allowNonStandardName: true });
    expect(good.isError, good.text).toBe(false);
    expect((good.json!.copy as Record<string, unknown>).name).toBe("report copy.pdf");
  });

  it("requires a destination", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { fromAccount: "work", fileId: "rep", toAccount: "personal", trashOriginal: false, allowNonStandardName: false });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/toPath or toFolderId/);
  });
});
