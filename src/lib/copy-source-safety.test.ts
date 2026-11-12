/**
 * R3-1: a read-only account is never modified when it is the SOURCE of a cross-account copy or transfer.
 *
 *   ro     read-only   ro@example.test      (source)
 *   rw     writable    rw@example.test      (source on the share path)
 *   dst    writable    dst@example.test     (destination)
 *   locked read-only   locked@example.test  (destination that must refuse)
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { readAudit } from "./audit";
import { FOLDER_MIME, SHORTCUT_MIME } from "./drive";
import { transfer, type TransferPlan, type TransferResult } from "./providers/transfer";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeAccountSpec, type FakeDrive, type FakeFile } from "./testing/fakeDrive";
import { registerAllTools, setDriveFetch } from "./tools";

const RO = "ro@example.test";
const RW = "rw@example.test";
const DST = "dst@example.test";
const LOCKED = "locked@example.test";
const SPECS: FakeAccountSpec[] = [
  { label: "ro", email: RO, mode: "read" },
  { label: "rw", email: RW },
  { label: "dst", email: DST },
  { label: "locked", email: LOCKED, mode: "read" },
];

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const { storeMock } = await import("./testing/fakeDrive");
  return {
    ...orig,
    ...storeMock([
      { label: "ro", email: "ro@example.test", mode: "read" },
      { label: "rw", email: "rw@example.test" },
      { label: "dst", email: "dst@example.test" },
      { label: "locked", email: "locked@example.test", mode: "read" },
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
  const t = r.content[0]?.text ?? "";
  return { isError: r.isError === true, text: t, json: r.isError ? undefined : (JSON.parse(t) as Record<string, unknown>) };
}

const GDOC = "application/vnd.google-apps.document";
const GFORM = "application/vnd.google-apps.form";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/**
 * ro:/Reports              rw:/Shared work
 *   summary.txt              plain.txt
 *   Minutes (Doc)            locked.txt (copyRequiresWriterPermission)
 *   Feedback (Form)        dst:/Inbox
 *   link -> summary.txt    locked:/In
 *   Sub/
 *     deep.txt
 */
function files(): Record<string, FakeFile> {
  const ro = [{ emailAddress: RO }];
  const rw = [{ emailAddress: RW }];
  const txt = (id: string, name: string, parent: string, owners: { emailAddress: string }[], content: string, extra: Partial<FakeFile> = {}): FakeFile => ({
    id,
    name,
    mimeType: "text/plain",
    parents: [parent],
    owners,
    size: String(content.length),
    content,
    md5Checksum: md5(content),
    modifiedTime: "2026-11-01T10:00:00.000Z",
    ...extra,
  });
  return {
    roRoot: { id: "roRoot", name: "My Drive", mimeType: FOLDER_MIME, owners: ro },
    reports: { id: "reports", name: "Reports", mimeType: FOLDER_MIME, parents: ["roRoot"], owners: ro, modifiedTime: "2026-11-01T10:00:00.000Z" },
    summary: txt("summary", "summary.txt", "reports", ro, "quarterly summary"),
    minutes: { id: "minutes", name: "Minutes", mimeType: GDOC, parents: ["reports"], owners: ro, modifiedTime: "2026-11-01T10:00:00.000Z" },
    form: { id: "form", name: "Feedback", mimeType: GFORM, parents: ["reports"], owners: ro },
    link: { id: "link", name: "link", mimeType: SHORTCUT_MIME, parents: ["reports"], owners: ro, shortcutDetails: { targetId: "summary", targetMimeType: "text/plain" } },
    sub: { id: "sub", name: "Sub", mimeType: FOLDER_MIME, parents: ["reports"], owners: ro },
    deep: txt("deep", "deep.txt", "sub", ro, "deep file"),
    rwRoot: { id: "rwRoot", name: "My Drive", mimeType: FOLDER_MIME, owners: rw },
    work: { id: "work", name: "Shared work", mimeType: FOLDER_MIME, parents: ["rwRoot"], owners: rw },
    plain: txt("plain", "plain.txt", "work", rw, "plain text"),
    lockedFile: txt("lockedFile", "locked.txt", "work", rw, "writers only", { copyRequiresWriterPermission: true }),
    dRoot: { id: "dRoot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: DST }] },
    inbox: { id: "inbox", name: "Inbox", mimeType: FOLDER_MIME, parents: ["dRoot"], owners: [{ emailAddress: DST }] },
    lRoot: { id: "lRoot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: LOCKED }] },
    lin: { id: "lin", name: "In", mimeType: FOLDER_MIME, parents: ["lRoot"], owners: [{ emailAddress: LOCKED }] },
  };
}

/** Every request the given account made that could change something (anything but GET). */
const writesBy = (b: FakeDrive, account: string) => b.log.filter((l) => l.account === account && l.method !== "GET");
const permissionWrites = (b: FakeDrive) => b.log.filter((l) => l.path.includes("/permissions") && l.method !== "GET");

let tools: Record<string, Handler>;
beforeEach(() => {
  setStore(memoryStore());
  tools = collectTools();
});
afterEach(() => {
  setDriveFetch(undefined);
  setStore(undefined);
});

describe("read-only source: streamed, never modified", () => {
  it("a single file streams through the server: no permission and no write of any kind on the source account", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const preview = await call(tools, "copy", { fromAccount: "ro", fileId: "summary", toAccount: "dst", toFolderId: "inbox", dryRun: true });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.json).toMatchObject({ dryRun: true, after: { method: "stream" } });
    expect(String(preview.json!.message)).toMatch(/streamed through this server because source account ro is read-only/);

    const r = await call(tools, "copy", { fromAccount: "ro", fileId: "summary", toAccount: "dst", toFolderId: "inbox" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ method: "stream", kind: "file", done: true, copy: { name: "summary.txt", account: "dst", path: "dst:/Inbox/summary.txt" } });
    expect(String(r.json!.note)).toMatch(/No permission was created on the source/);
    const copy = Object.values(b.files).find((f) => f.parents?.includes("inbox") && f.name === "summary.txt");
    expect(copy?.content).toBe("quarterly summary");
    expect(writesBy(b, "ro")).toEqual([]);
    expect(permissionWrites(b)).toEqual([]);
    expect(b.log.some((l) => l.path.endsWith("/copy"))).toBe(false);
    const audit = await readAudit(10);
    expect(audit.map((e) => e.tool)).toEqual(["copy"]);
    expect(audit[0]).toMatchObject({ account: "ro", toAccount: "dst", note: expect.stringMatching(/streamed \(source account ro is read-only/) });
  });

  it("a Google Doc is exported to docx and imported back as a Doc, flagged as converted", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const preview = await call(tools, "copy", { fromAccount: "ro", fileId: "minutes", toAccount: "dst", toFolderId: "inbox", dryRun: true });
    expect(preview.json!.after).toMatchObject({ method: "stream", converted: expect.stringMatching(/comments, revision history and some formatting are not preserved/) });
    const r = await call(tools, "copy", { fromAccount: "ro", fileId: "minutes", toAccount: "dst", toFolderId: "inbox" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ converted: [{ note: "converted (export/import): comments, revision history and some formatting are not preserved" }], copy: { name: "Minutes", mimeType: GDOC } });
    const session = Object.values(b.sessions)[0]!;
    expect(session).toMatchObject({ account: "dst", contentType: DOCX, meta: { name: "Minutes", mimeType: GDOC } });
    expect(b.log.some((l) => l.account === "ro" && l.path === "/drive/v3/files/minutes/export" && l.params.get("mimeType") === DOCX)).toBe(true);
    expect(writesBy(b, "ro")).toEqual([]);
  });

  it("a Google Form has no export/import path: refused in the dry run and the real run with the reason, nothing written", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    for (const dryRun of [true, false]) {
      const r = await call(tools, "copy", { fromAccount: "ro", fileId: "form", toAccount: "dst", toFolderId: "inbox", dryRun });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/not copied: Google-native type application\/vnd\.google-apps\.form has no export\/import path/);
    }
    expect(b.log.filter((l) => l.method !== "GET")).toEqual([]);
  });

  it("a folder tree streams in resumable slices; the dry run predicts exactly what streams, converts and is skipped", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const base = { fromAccount: "ro", fileId: "reports", toAccount: "dst", toFolderId: "inbox" };
    const plan = await call(tools, "copy", { ...base, dryRun: true });
    expect(plan.isError, plan.text).toBe(false);
    expect(plan.json).toMatchObject({ dryRun: true, method: "stream", kind: "folder", streamed: 2, converted: 1, unsupported: 2, files: 3, folders: 2 });
    const issues = (plan.json!.issues as { path: string; issue: string }[]).map((i) => `${i.path}: ${i.issue}`).join("\n");
    expect(issues).toMatch(/Minutes: will be converted \(export\/import\)/);
    expect(issues).toMatch(/Feedback: will be skipped: Google-native type application\/vnd\.google-apps\.form/);
    expect(issues).toMatch(/link: will be skipped: Google Drive shortcut/);
    expect(b.log.filter((l) => l.method !== "GET")).toEqual([]);

    const slices: Record<string, unknown>[] = [];
    let resume: string | undefined;
    do {
      const r = await call(tools, "copy", { ...base, maxFiles: 2, ...(resume ? { resume } : {}) });
      expect(r.isError, r.text).toBe(false);
      slices.push(r.json!);
      resume = r.json!.resume as string | undefined;
      if (slices.length > 10) throw new Error("never finished");
    } while (resume);
    expect(slices.length).toBeGreaterThan(1);
    const last = slices.at(-1)!;
    expect(last).toMatchObject({ done: true, method: "stream", totals: { copied: 3, converted: 1, unsupported: 2, failed: 0 } });
    const converted = slices.flatMap((s) => s.converted as { path: string }[]).map((c) => c.path);
    const notCopied = slices.flatMap((s) => s.notCopied as { path: string; reason: string }[]).map((c) => c.path);
    expect(converted).toEqual(["/Reports/Minutes"]);
    expect(notCopied.sort()).toEqual(["/Reports/Feedback", "/Reports/link"]);
    // Parity: the dry run predicted the same split the copy produced.
    expect([plan.json!.converted, plan.json!.unsupported]).toEqual([converted.length, notCopied.length]);
    const top = Object.values(b.files).find((f) => f.parents?.includes("inbox") && f.name === "Reports")!;
    const names = Object.values(b.files).filter((f) => f.parents?.includes(top.id)).map((f) => f.name).sort();
    expect(names).toEqual(["Minutes", "Sub", "summary.txt"]);
    expect(writesBy(b, "ro")).toEqual([]);
    expect(permissionWrites(b)).toEqual([]);
    // A repeat is idempotent.
    const again = await call(tools, "copy", base);
    expect(again.json).toMatchObject({ done: true, copied: 0, skipped: 3 });
  });

  it("transfer from a read-only Google account streams too, and its dry run says so", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const plan = (await transfer({ from: "ro:/Reports", to: "dst:/Inbox", dryRun: true }, { actor: "t" })) as TransferPlan;
    expect(plan.route).toMatch(/streamed through this server: source account ro is read-only/);
    expect(plan).toMatchObject({ streamed: 2, converted: 1, unsupported: 2 });
    const r = (await transfer({ from: "ro:/Reports/summary.txt", to: "dst:/Inbox", dryRun: false }, { actor: "t" })) as TransferResult;
    expect(r).toMatchObject({ done: true, totals: { copied: 1, verifiedHash: 1 } });
    expect(writesBy(b, "ro")).toEqual([]);
    expect(permissionWrites(b)).toEqual([]);
  });

  it("refuses trashOriginal / move from a read-only source and any copy INTO a read-only account, dry runs included", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    for (const dryRun of [true, false]) {
      const trash = await call(tools, "copy", { fromAccount: "ro", fileId: "summary", toAccount: "dst", toFolderId: "inbox", trashOriginal: true, dryRun });
      expect(trash.isError).toBe(true);
      expect(trash.text).toMatch(/account ro is read-only/);
      const into = await call(tools, "copy", { fromAccount: "rw", fileId: "plain", toAccount: "locked", toFolderId: "lin", dryRun });
      expect(into.isError).toBe(true);
      expect(into.text).toMatch(/account locked is read-only/);
      await expect(transfer({ from: "ro:/Reports", to: "dst:/Inbox", move: true, dryRun }, { actor: "t" })).rejects.toThrow(/account ro is read-only/);
      await expect(transfer({ from: "rw:/Shared work", to: "locked:/In", dryRun }, { actor: "t" })).rejects.toThrow(/account locked is read-only/);
    }
    expect(b.log.filter((l) => l.method !== "GET")).toEqual([]);
  });
});

describe("writable source: least-privilege temporary grants", () => {
  it("a file only writers may copy (copyRequiresWriterPermission) streams instead of getting a grant", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const preview = await call(tools, "copy", { fromAccount: "rw", fileId: "lockedFile", toAccount: "dst", toFolderId: "inbox", dryRun: true });
    expect(preview.json!.after).toMatchObject({ method: "stream", streamReason: expect.stringMatching(/copyRequiresWriterPermission/) });
    const r = await call(tools, "copy", { fromAccount: "rw", fileId: "lockedFile", toAccount: "dst", toFolderId: "inbox" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ method: "stream", copy: { name: "locked.txt" } });
    expect(permissionWrites(b)).toEqual([]);
    expect(writesBy(b, "rw")).toEqual([]);
  });

  it("the same file inside a folder copy streams while its siblings get per-file reader grants; the dry run predicts it", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const base = { fromAccount: "rw", fileId: "work", toAccount: "dst", toFolderId: "inbox" };
    const plan = await call(tools, "copy", { ...base, dryRun: true });
    expect(plan.json).toMatchObject({ grantedFiles: 1, streamedFiles: 1, predictions: [{ name: "locked.txt", issue: expect.stringMatching(/will stream/) }] });
    const r = await call(tools, "copy", base);
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ done: true, copiedFiles: 2, streamedFiles: 1, temporaryGrants: { created: 1, removed: 1 } });
    const grants = b.log.filter((l) => l.method === "POST" && l.path.endsWith("/permissions"));
    expect(grants.map((g) => g.path)).toEqual(["/drive/v3/files/plain/permissions"]);
    expect(grants[0]!.body).toMatchObject({ role: "reader" });
  });

  it("removes the grant when the copy fails, and audits both", async () => {
    const b = fakeDrive(SPECS, files(), { failCopyIds: ["plain"], failCopyStatus: 403 });
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { fromAccount: "rw", fileId: "plain", toAccount: "dst", toFolderId: "inbox" });
    expect(r.isError).toBe(true);
    expect(b.permissions.plain!.map((p) => p.role)).toEqual(["owner"]);
    const audit = await readAudit(10);
    expect(audit.map((e) => e.tool)).toEqual(["temp_grant_removed", "temp_grant"]);
    expect(audit[1]).toMatchObject({ account: "rw", toAccount: "dst", fileId: "plain", role: "reader", email: DST, permissionId: expect.stringMatching(/^perm/), expiresAt: expect.any(String) });
    const status = await call(tools, "status", {});
    expect(status.json!.temporaryGrants).toMatchObject({ open: [], goneOnDrive: 0 });
  });

  it("a removal that fails is reported loudly with the permission id, and status/permissions list the leftover until it is gone", async () => {
    const b = fakeDrive(SPECS, files(), { failRemovePermissionWith: 500 });
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { fromAccount: "rw", fileId: "plain", toAccount: "dst", toFolderId: "inbox" });
    expect(r.isError, r.text).toBe(false);
    const permId = (r.json!.temporaryGrant as { permissionId: string }).permissionId;
    expect(r.json).toMatchObject({ temporaryGrant: { removed: false, role: "reader" } });
    const warning = String(r.json!.warning);
    expect(warning.startsWith(`TEMPORARY GRANT NOT REMOVED (permission id ${permId}): `)).toBe(true);
    expect(warning).toContain('unshare {account:"rw", fileId:"plain", email:"dst@example.test"}');
    expect((await readAudit(10)).map((e) => e.tool)).toContain("temp_grant_remove_failed");

    const st = await call(tools, "status", {});
    expect(st.json!.temporaryGrants).toMatchObject({ open: [{ account: "rw", fileId: "plain", permissionId: permId, role: "reader", email: DST }] });
    expect((st.json!.warnings as string[]).join("\n")).toMatch(/temporary copy grant is still in place/);
    const perms = await call(tools, "permissions", { account: "rw", fileId: "plain" });
    expect((perms.json!.permissions as { id: string; temporary?: boolean; expirationTime?: string }[]).find((p) => p.id === permId)).toMatchObject({ temporary: true, expirationTime: expect.any(String) });
    const left = await call(tools, "permissions", { account: "rw", leftovers: true });
    expect(left.json!.temporaryGrants).toMatchObject({ open: [{ permissionId: permId }] });

    // Once Drive no longer has it (removed by hand or expired), the leftover is verified gone and no longer reported.
    b.permissions.plain = b.permissions.plain!.filter((p) => p.id !== permId);
    const after = await call(tools, "status", {});
    expect(after.json!.temporaryGrants).toMatchObject({ open: [], goneOnDrive: 1 });
    expect((await call(tools, "status", {})).json!.temporaryGrants).toMatchObject({ open: [], goneOnDrive: 0 });
  });

  it("creates the grant without an expiry when Drive refuses one, and says so", async () => {
    const b = fakeDrive(SPECS, files(), { rejectExpiration: true });
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "copy", { fromAccount: "rw", fileId: "plain", toAccount: "dst", toFolderId: "inbox" });
    expect(r.isError, r.text).toBe(false);
    expect(String(r.json!.note)).toMatch(/Drive refused an expiration time/);
    expect(r.json).toMatchObject({ temporaryGrant: { removed: true, role: "reader" } });
    expect((r.json!.temporaryGrant as { expiresAt?: string }).expiresAt).toBeUndefined();
  });

  it("transfer between two writable Google accounts uses a per-file reader grant and reports it in the dry run", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const plan = (await transfer({ from: "rw:/Shared work/plain.txt", to: "dst:/Inbox", dryRun: true }, { actor: "t" })) as TransferPlan;
    expect(plan.issues[0]!.issue).toMatch(/temporary reader access to this one file/);
    const r = (await transfer({ from: "rw:/Shared work/plain.txt", to: "dst:/Inbox", dryRun: false }, { actor: "t" })) as TransferResult;
    expect(r.done).toBe(true);
    expect(b.log.filter((l) => l.method === "POST" && l.path.endsWith("/permissions")).map((l) => (l.body as { role: string }).role)).toEqual(["reader"]);
    expect(b.permissions.plain!.map((p) => p.role)).toEqual(["owner"]);
  });
});
