import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { FOLDER_MIME, SHORTCUT_MIME } from "./drive";
import { registerAllTools, registerReadTools, setDriveFetch } from "./tools";
import { setStore } from "./store";
import { readAudit } from "./audit";
import { canTransferDirectly } from "./permissions";
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

function collectTools(register = registerAllTools): Record<string, Handler> {
  const tools: Record<string, Handler> = {};
  const server = { registerTool: (name: string, _d: unknown, h: Handler) => void (tools[name] = h) } as unknown as McpServer;
  register(server);
  return tools;
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
    rep: { id: "rep", name: "2026-01-05_Acme_Report.pdf", mimeType: "application/pdf", parents: ["co"], owners: [{ emailAddress: WORK }], perms: { [TEAM]: "reader" } },
    ro: { id: "ro", name: "Plan.docx", mimeType: "application/msword", owners: [{ emailAddress: TEAM }], perms: { [WORK]: "reader" }, sharedWithMe: true },
    proot: { id: "proot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: PERSONAL }] },
    note: { id: "note", name: "2026-02-01_Personal_Note.md", mimeType: "text/markdown", parents: ["proot"], owners: [{ emailAddress: PERSONAL }] },
  };
}

describe("permissions tools", () => {
  let tools: Record<string, Handler>;
  beforeEach(() => {
    setStore(memoryStore());
    tools = collectTools();
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("permissions lists who has access, and is available read-only", async () => {
    setDriveFetch(fakeDrive(SPECS, files()).fetchImpl);
    const r = await call(tools, "permissions", { account: "work", fileId: "rep" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json!.file).toMatchObject({ id: "rep", path: "work:/01_Company/2026-01-05_Acme_Report.pdf" });
    expect(r.json!.permissions).toEqual([
      { id: "owner-perm", email: WORK, role: "owner", type: "user", displayName: "Owner" },
      { id: "seed0", email: TEAM, role: "reader", type: "user" },
    ]);
    const readOnly = collectTools(registerReadTools);
    expect(Object.keys(readOnly)).toContain("permissions");
    for (const w of ["share", "unshare", "transfer_ownership", "shortcut", "copy", "batch"]) expect(Object.keys(readOnly)).not.toContain(w);
  });

  it("share grants a role without e-mail by default and audits it", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "share", { account: "work", fileId: "rep", email: "cfo@acme.example", role: "commenter", notify: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.json!.permission).toMatchObject({ email: "cfo@acme.example", role: "commenter", type: "user" });
    const req = b.log.find((l) => l.method === "POST" && l.path === "/drive/v3/files/rep/permissions")!;
    expect(req.body).toEqual({ type: "user", role: "commenter", emailAddress: "cfo@acme.example" });
    expect(req.params.get("sendNotificationEmail")).toBe("false");
    expect(req.params.has("emailMessage")).toBe(false);
    expect((await readAudit(5))[0]).toMatchObject({ tool: "share", account: "work", fileId: "rep", email: "cfo@acme.example", role: "commenter", owner: "me" });

    const notified = await call(tools, "share", { account: "work", fileId: "rep", email: "x@y.com", role: "reader", notify: true, message: "FYI" });
    expect(notified.isError).toBe(false);
    const req2 = b.log.filter((l) => l.method === "POST" && l.path === "/drive/v3/files/rep/permissions").at(-1)!;
    expect(req2.params.get("sendNotificationEmail")).toBe("true");
    expect(req2.params.get("emailMessage")).toBe("FYI");
  });

  it("share and unshare are refused on items the account cannot share", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "share", { account: "work", fileId: "ro", email: "x@y.com", role: "reader", notify: false });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^cannot change sharing of Plan.docx \(owner team@acme.example\)/);
    const u = await call(tools, "unshare", { account: "work", fileId: "ro", email: TEAM });
    expect(u.isError).toBe(true);
    expect(b.log.filter((l) => l.method !== "GET")).toHaveLength(0);
    expect(await readAudit(5)).toEqual([]);
  });

  it("unshare removes exactly that person's permission, never the owner's, and never the file", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "unshare", { account: "work", fileId: "rep", email: TEAM.toUpperCase() });
    expect(r.isError, r.text).toBe(false);
    expect(r.json!.removed).toMatchObject({ email: TEAM, role: "reader" });
    expect(b.log.find((l) => l.method === "DELETE")!.path).toBe("/drive/v3/files/rep/permissions/seed0");
    expect(b.permissions.rep!.map((p) => p.role)).toEqual(["owner"]);
    expect(b.files.rep).toBeDefined();
    expect((await readAudit(5))[0]).toMatchObject({ tool: "unshare", email: TEAM.toUpperCase(), role: "reader" });

    const owner = await call(tools, "unshare", { account: "work", fileId: "rep", email: WORK });
    expect(owner.isError).toBe(true);
    expect(owner.text).toMatch(/owns .* cannot be removed/);
    const none = await call(tools, "unshare", { account: "work", fileId: "rep", email: "nobody@x.com" });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/has no permission on/);
  });

  it("canTransferDirectly only within one Workspace domain", () => {
    expect(canTransferDirectly("alex@acme.example", "cfo@acme.example")).toBe(true);
    expect(canTransferDirectly("alex@acme.example", "cfo@Acme.example")).toBe(true);
    expect(canTransferDirectly("alex@acme.example", "someone@gmail.com")).toBe(false);
    expect(canTransferDirectly("alex.example@gmail.com", "other@gmail.com")).toBe(false);
    expect(canTransferDirectly("alex@acme.example", "a@client-a.example")).toBe(false);
  });

  it("transfer_ownership transfers directly inside the Workspace domain", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "transfer_ownership", { account: "work", fileId: "rep", toEmail: "cfo@acme.example" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ mode: "transferred", toEmail: "cfo@acme.example", permission: { role: "owner" } });
    const req = b.log.find((l) => l.method === "POST" && l.path === "/drive/v3/files/rep/permissions")!;
    expect(req.body).toEqual({ type: "user", role: "owner", emailAddress: "cfo@acme.example" });
    expect(req.params.get("transferOwnership")).toBe("true");
    expect(req.params.get("sendNotificationEmail")).toBe("true");
    expect((await readAudit(5))[0]).toMatchObject({ tool: "transfer_ownership", email: "cfo@acme.example", role: "owner" });
  });

  it("transfer_ownership from a Gmail account uses the pendingOwner invitation and says the recipient must accept", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "transfer_ownership", { account: "personal", fileId: "note", toEmail: "friend@gmail.com" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ mode: "pending", permission: { role: "writer", pendingOwner: true } });
    expect(r.json!.note).toMatch(/must accept/i);
    const create = b.log.find((l) => l.method === "POST" && l.path === "/drive/v3/files/note/permissions")!;
    expect(create.body).toEqual({ type: "user", role: "writer", emailAddress: "friend@gmail.com" });
    expect(create.params.has("transferOwnership")).toBe(false);
    const patch = b.log.find((l) => l.method === "PATCH" && l.path.startsWith("/drive/v3/files/note/permissions/"))!;
    expect(patch.body).toEqual({ role: "writer", pendingOwner: true });
    expect((await readAudit(5))[0]).toMatchObject({ tool: "transfer_ownership", account: "personal", role: "pendingOwner" });
  });

  it("transfer_ownership is refused when the account is not the owner", async () => {
    setDriveFetch(fakeDrive(SPECS, files()).fetchImpl);
    const r = await call(tools, "transfer_ownership", { account: "work", fileId: "ro", toEmail: "cfo@acme.example" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/only the owner can transfer ownership of Plan.docx/);
  });

  it("shortcut creates a Drive shortcut in the target folder and audits it", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "shortcut", { account: "work", targetId: "rep", path: "work:/" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ name: "2026-01-05_Acme_Report.pdf", mimeType: SHORTCUT_MIME, path: "work:/2026-01-05_Acme_Report.pdf", targetId: "rep", targetPath: "work:/01_Company/2026-01-05_Acme_Report.pdf" });
    const req = b.log.find((l) => l.method === "POST" && l.path === "/drive/v3/files")!;
    expect(req.body).toEqual({ name: "2026-01-05_Acme_Report.pdf", mimeType: SHORTCUT_MIME, parents: ["root"], shortcutDetails: { targetId: "rep" } });
    expect((await readAudit(5))[0]).toMatchObject({ tool: "shortcut", from: "rep", to: "root" });

    const named = await call(tools, "shortcut", { account: "work", targetId: "co", folderId: "root", name: "Company link" });
    expect(named.isError).toBe(false);
    expect(named.json!.name).toBe("Company link");
    const missing = await call(tools, "shortcut", { account: "work", targetId: "co" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/path or folderId/);
  });
});
