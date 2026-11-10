import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { readAudit } from "./audit";
import { DriveClient, FOLDER_MIME } from "./drive";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";
import { registerAllTools, registerReadTools, setDriveFetch } from "./tools";
import { CHUNK_BYTES, putToSession, SESSION_TTL_SECONDS, uploadFromUrl } from "./upload";


// These tests exercise the optional naming rule (VAULT_NAMING_RULE=date-entity).
process.env.VAULT_NAMING_RULE = "date-entity";
const WORK = "alex@acme.example";
const SPECS = [{ label: "work", email: WORK }];

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const { storeMock } = await import("./testing/fakeDrive");
  return { ...orig, ...storeMock([{ label: "work", email: "alex@acme.example" }]) };
});

type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect(register: (s: McpServer) => void): Record<string, Handler> {
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
    ro: { id: "ro", name: "ReadOnly", mimeType: FOLDER_MIME, owners: [{ emailAddress: "x@y.com" }], perms: { [WORK]: "reader" }, sharedWithMe: true },
  };
}

const KB256 = 256 * 1024;

/** Serve `bytes` for https://files.example.com/*; `chunk` splits the body into a stream of that many bytes; `length` false omits Content-Length. */
function external(bytes: Buffer, opts: { chunk?: number; length?: boolean; type?: string } = {}) {
  return (url: URL) => {
    if (url.hostname !== "files.example.com") return undefined;
    const step = opts.chunk ?? 1000;
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= bytes.length) return controller.close();
        controller.enqueue(new Uint8Array(bytes.subarray(i, i + step)));
        i += step;
      },
    });
    const headers: Record<string, string> = { "Content-Type": opts.type ?? "application/pdf" };
    if (opts.length !== false) headers["Content-Length"] = String(bytes.length);
    return new Response(stream, { status: 200, headers });
  };
}

describe("upload_begin / upload_finish", () => {
  let tools: Record<string, Handler>;
  beforeEach(() => {
    setStore(memoryStore());
    tools = collect(registerAllTools);
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("opens a pre-authorised resumable session after checking the name and write access", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const bad = await call(tools, "upload_begin", { account: "work", path: "work:/01_Company", name: "deck.pdf", mimeType: "application/pdf", size: 10, allowNonStandardName: false });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/naming rule/);
    const view = await call(tools, "upload_begin", { account: "work", folderId: "ro", name: "2026-11-10_Acme_Deck.pdf", mimeType: "application/pdf", size: 10, allowNonStandardName: false });
    expect(view.isError).toBe(true);
    expect(view.text).toMatch(/^view-only/);
    expect(b.log.filter((l) => l.path.startsWith("/upload"))).toHaveLength(0);

    const r = await call(tools, "upload_begin", { account: "work", path: "work:/01_Company", name: "2026-11-10_Acme_Deck.pdf", mimeType: "application/pdf", size: 3 * CHUNK_BYTES + 5, allowNonStandardName: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({
      account: "work",
      name: "2026-11-10_Acme_Deck.pdf",
      folderId: "co",
      folderPath: "work:/01_Company",
      size: 3 * CHUNK_BYTES + 5,
      uploadUrl: expect.stringMatching(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=resumable&upload_id=session\d+$/),
      expiresInSeconds: SESSION_TTL_SECONDS,
      chunkBytes: CHUNK_BYTES,
    });
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 3600);
    expect(r.json!.instructions).toMatch(/Content-Range: bytes 0-25165828\/25165829/);
    const begin = b.log.find((l) => l.path === "/upload/drive/v3/files" && l.method === "POST")!;
    expect(begin.params.get("uploadType")).toBe("resumable");
    expect(begin.params.get("supportsAllDrives")).toBe("true");
    expect(begin.body).toEqual({ name: "2026-11-10_Acme_Deck.pdf", parents: ["co"], mimeType: "application/pdf" });
    const session = Object.values(b.sessions)[0]!;
    expect(session).toMatchObject({ contentType: "application/pdf", declaredSize: 3 * CHUNK_BYTES + 5 });
    expect((await readAudit(5))[0]).toMatchObject({ tool: "upload_begin", account: "work", name: "2026-11-10_Acme_Deck.pdf", to: "co", size: 3 * CHUNK_BYTES + 5 });
  });

  it("the client PUTs chunks without credentials; upload_finish audits the file", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const data = Buffer.alloc(KB256 * 2 + 7, "a");
    const r = await call(tools, "upload_begin", { account: "work", folderId: "co", name: "2026-11-10_Acme_Data.bin", mimeType: "application/octet-stream", size: data.length, allowNonStandardName: false });
    expect(r.isError, r.text).toBe(false);
    const url = r.json!.uploadUrl as string;
    // Chunked PUTs straight to the session (as a client would), with a status query in between.
    const p1 = await b.fetchImpl(url, { method: "PUT", headers: { "Content-Range": `bytes 0-${KB256 - 1}/${data.length}` }, body: new Uint8Array(data.subarray(0, KB256)) });
    expect(p1.status).toBe(308);
    expect(p1.headers.get("Range")).toBe(`bytes=0-${KB256 - 1}`);
    const status = await b.fetchImpl(url, { method: "PUT", headers: { "Content-Range": `bytes */${data.length}` } });
    expect(status.status).toBe(308);
    expect(status.headers.get("Range")).toBe(`bytes=0-${KB256 - 1}`);
    const p2 = await b.fetchImpl(url, { method: "PUT", headers: { "Content-Range": `bytes ${KB256}-${data.length - 1}/${data.length}` }, body: new Uint8Array(data.subarray(KB256)) });
    expect(p2.status).toBe(200);
    const file = (await p2.json()) as { id: string; name: string; size: string };
    expect(file).toMatchObject({ name: "2026-11-10_Acme_Data.bin", size: String(data.length) });
    for (const l of b.log.filter((x) => x.method === "PUT")) expect(l.path).toBe("/upload/drive/v3/files");

    const fin = await call(tools, "upload_finish", { account: "work", fileId: file.id });
    expect(fin.isError, fin.text).toBe(false);
    expect(fin.json).toMatchObject({ id: file.id, name: "2026-11-10_Acme_Data.bin", path: "work:/01_Company/2026-11-10_Acme_Data.bin", size: data.length, owner: "me" });
    const audit = await readAudit(5);
    expect(audit[0]).toMatchObject({ tool: "upload_finish", account: "work", fileId: file.id, name: "2026-11-10_Acme_Data.bin", to: "co", size: data.length });
    expect(audit[1]!.tool).toBe("upload_begin");
    const folder = await call(tools, "upload_finish", { account: "work", fileId: "co" });
    expect(folder.isError).toBe(true);
  });

  it("is only available with a full-access token", () => {
    const ro = collect(registerReadTools);
    expect(ro.upload_begin).toBeUndefined();
    expect(ro.upload_finish).toBeUndefined();
    expect(tools.upload_begin).toBeDefined();
  });
});

describe("put with sourceUrl", () => {
  let tools: Record<string, Handler>;
  beforeEach(() => {
    setStore(memoryStore());
    tools = collect(registerAllTools);
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("streams an https file into a resumable session and audits size and source", async () => {
    const data = Buffer.from("hello web ".repeat(1000));
    const b = fakeDrive(SPECS, files(), { external: external(data) });
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "put", { account: "work", path: "work:/01_Company", name: "2026-11-10_Acme_Web.pdf", sourceUrl: "https://files.example.com/x.pdf", allowNonStandardName: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ name: "2026-11-10_Acme_Web.pdf", path: "work:/01_Company/2026-11-10_Acme_Web.pdf", mimeType: "application/pdf", size: data.length, bytes: data.length, sourceUrl: "https://files.example.com/x.pdf" });
    const session = Object.values(b.sessions)[0]!;
    expect(session).toMatchObject({ contentType: "application/pdf", declaredSize: data.length, receivedBytes: data.length });
    expect(session.ranges).toEqual([`bytes 0-${data.length - 1}/${data.length}`]);
    expect(Buffer.concat(session.received.map((c) => Buffer.from(c))).equals(data)).toBe(true);
    expect((await readAudit(5))[0]).toMatchObject({ tool: "put", account: "work", name: "2026-11-10_Acme_Web.pdf", to: "co", size: data.length, sourceUrl: "https://files.example.com/x.pdf" });
  });

  it("refuses http, oversize (by Content-Length) and mixed arguments before opening a session", async () => {
    const b = fakeDrive(SPECS, files(), { external: external(Buffer.alloc(10), { length: true }) });
    setDriveFetch(b.fetchImpl);
    const base = { account: "work", folderId: "co", name: "2026-11-10_Acme_Web.pdf", allowNonStandardName: false };
    expect((await call(tools, "put", { ...base, sourceUrl: "http://files.example.com/x.pdf" })).text).toMatch(/https/);
    expect((await call(tools, "put", { ...base, sourceUrl: "https://files.example.com/x.pdf", content: "x" })).text).toMatch(/exactly one/);
    expect((await call(tools, "put", { ...base })).text).toMatch(/exactly one/);
    expect(b.log.filter((l) => l.path.startsWith("/upload"))).toHaveLength(0);
    const big = fakeDrive(SPECS, files(), { external: () => new Response("", { headers: { "Content-Length": String(201 * 1024 * 1024) } }) });
    setDriveFetch(big.fetchImpl);
    const r = await call(tools, "put", { ...base, sourceUrl: "https://files.example.com/huge.bin" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/limit is 209715200 bytes \(200 MB\)/);
    expect(big.log.filter((l) => l.path.startsWith("/upload"))).toHaveLength(0);
  });

  it("content uploads still work and record the size", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await call(tools, "put", { account: "work", folderId: "co", name: "2026-11-10_Acme_Note.txt", content: "hello", allowNonStandardName: false });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ name: "2026-11-10_Acme_Note.txt", mimeType: "text/plain", size: 5 });
    expect((await readAudit(1))[0]).toMatchObject({ tool: "put", size: 5 });
  });
});

describe("putToSession / uploadFromUrl", () => {
  afterEach(() => setDriveFetch(undefined));

  it("sends 256 KiB-aligned chunks with Content-Range, the last one carrying the total", async () => {
    const data = Buffer.alloc(KB256 * 2 + 100, "z");
    const b = fakeDrive(SPECS, files(), { external: external(data, { chunk: 70_000 }) });
    const drive = new DriveClient("tok-work", b.fetchImpl);
    const r = await uploadFromUrl(drive, b.fetchImpl, { sourceUrl: "https://files.example.com/z.bin", name: "z.bin", folderId: "co" }, { chunkBytes: KB256 });
    expect(r.bytes).toBe(data.length);
    expect(r.contentType).toBe("application/pdf");
    const session = Object.values(b.sessions)[0]!;
    expect(session.ranges).toEqual([`bytes 0-${KB256 - 1}/${data.length}`, `bytes ${KB256}-${2 * KB256 - 1}/${data.length}`, `bytes ${2 * KB256}-${data.length - 1}/${data.length}`]);
    expect(Buffer.concat(session.received.map((c) => Buffer.from(c))).equals(data)).toBe(true);
    expect(b.files[r.file.id]).toMatchObject({ name: "z.bin", size: String(data.length) });
  });

  it("works without Content-Length (`*` until the final chunk) and enforces maxBytes while streaming", async () => {
    const data = Buffer.alloc(KB256 + 10, "q");
    const b = fakeDrive(SPECS, files(), { external: external(data, { chunk: 50_000, length: false }) });
    const drive = new DriveClient("tok-work", b.fetchImpl);
    const r = await uploadFromUrl(drive, b.fetchImpl, { sourceUrl: "https://files.example.com/q.bin", name: "q.bin", folderId: "co", mimeType: "text/plain" }, { chunkBytes: KB256 });
    const session = Object.values(b.sessions)[0]!;
    expect(session.declaredSize).toBeUndefined();
    expect(session.contentType).toBe("text/plain");
    expect(session.ranges).toEqual([`bytes 0-${KB256 - 1}/*`, `bytes ${KB256}-${data.length - 1}/${data.length}`]);
    expect(b.files[r.file.id]!.mimeType).toBe("text/plain");

    const c = fakeDrive(SPECS, files(), { external: external(data, { chunk: 50_000, length: false }) });
    await expect(uploadFromUrl(new DriveClient("tok-work", c.fetchImpl), c.fetchImpl, { sourceUrl: "https://files.example.com/q.bin", name: "q.bin", folderId: "co" }, { chunkBytes: KB256, maxBytes: 100_000 })).rejects.toThrow(/exceeds 100000 bytes/);
    expect(Object.keys(c.files).some((id) => c.files[id]!.name === "q.bin")).toBe(false);
  });

  it("handles an empty body and rejects unaligned chunk sizes", async () => {
    const b = fakeDrive(SPECS, files());
    const drive = new DriveClient("tok-work", b.fetchImpl);
    const url = await drive.beginResumableUpload({ name: "empty.txt", parents: ["co"] }, "text/plain", 0);
    const file = await putToSession(b.fetchImpl, url, (async function* () {})(), { size: 0 });
    expect(b.files[file.id]).toMatchObject({ name: "empty.txt", size: "0" });
    expect(Object.values(b.sessions)[0]!.ranges).toEqual(["bytes */0"]);
    await expect(putToSession(b.fetchImpl, url, (async function* () {})(), { chunkBytes: 1000 })).rejects.toThrow(/multiple of 256 KiB/);
  });
});
