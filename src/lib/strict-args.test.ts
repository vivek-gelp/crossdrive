/**
 * Unknown arguments are rejected at runtime, through the same path a real client takes: mcp-handler's HTTP handler
 * and the MCP SDK's own argument validation (as in app/api/mcp/route.ts), not by calling handlers directly.
 * Live test round 4 (R4-2): `mkdir {path: ...}` used to drop `path` silently and create the folder at the root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler } from "mcp-handler";
import { FOLDER_MIME } from "./drive";
import { registerAllTools, registerReadTools, setDriveFetch } from "./tools";
import { setStore } from "./store";
import { readAudit } from "./audit";
import { suggestKeys, unknownKeysMessage } from "./strict";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";

const WORK = "alex@acme.example";
const SPECS = [{ label: "work", email: WORK }];

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const { storeMock } = await import("./testing/fakeDrive");
  return { ...orig, ...storeMock([{ label: "work", email: "alex@acme.example" }]) };
});

function files(): Record<string, FakeFile> {
  return {
    root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: WORK }] },
    proj: { id: "proj", name: "Projects", mimeType: FOLDER_MIME, parents: ["root"], owners: [{ emailAddress: WORK }] },
    a: { id: "a", name: "notes.txt", mimeType: "text/plain", parents: ["proj"], owners: [{ emailAddress: WORK }], size: "5" },
  };
}

type CallResult = { isError: boolean; text: string };

/** One JSON-RPC exchange with a fresh handler, the way route.ts builds it. */
async function rpc(full: boolean, method: string, params: unknown): Promise<Record<string, unknown>> {
  const handler = createMcpHandler(full ? registerAllTools : registerReadTools, { serverInfo: { name: "crossdrive", version: "test" } });
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    handler(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extra },
        body: JSON.stringify(body),
      }),
    );
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  });
  const session = init.headers.get("mcp-session-id");
  const extra: Record<string, string> = { "mcp-protocol-version": "2025-06-18", ...(session ? { "mcp-session-id": session } : {}) };
  await init.text();
  const res = await post({ jsonrpc: "2.0", id: 2, method, params }, extra);
  const raw = await res.text();
  const json = raw.trim().startsWith("{") ? raw : (raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? raw);
  return JSON.parse(json) as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>, full = true): Promise<CallResult> {
  const msg = await rpc(full, "tools/call", { name, arguments: args });
  if (msg.error) return { isError: true, text: String((msg.error as { message: string }).message) };
  const r = msg.result as { content: { text: string }[]; isError?: boolean };
  return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
}

describe("unknown tool arguments are rejected, not ignored", () => {
  let drive: ReturnType<typeof fakeDrive>;
  beforeEach(() => {
    setStore(memoryStore());
    drive = fakeDrive(SPECS, files());
    setDriveFetch(drive.fetchImpl);
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  const writes = () => drive.log.filter((l) => l.method !== "GET");

  it("a read tool refuses an unknown key and names it with the accepted keys", async () => {
    const r = await callTool("list", { account: "work", path: "work:/Projects", folder: "proj" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown argument "folder"/);
    expect(r.text).toMatch(/did you mean "folderId"/);
    expect(r.text).toMatch(/Accepted arguments: .*account.*path.*folderId/);
    expect(drive.log).toHaveLength(0);
  });

  it("mkdir with `path` instead of `parentPath` writes nothing and suggests parentPath (R4-2)", async () => {
    const r = await callTool("mkdir", { account: "work", path: "work:/Projects", name: "R4" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown argument "path" \(did you mean "parentPath"/);
    expect(r.text).toMatch(/nothing was done/);
    expect(writes()).toHaveLength(0);
    expect(Object.values(drive.files).some((f) => f.name === "R4")).toBe(false);
    expect(await readAudit(10)).toEqual([]);
  });

  it("mkdir without any destination is refused instead of defaulting to the root", async () => {
    const r = await callTool("mkdir", { account: "work", name: "R4" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/mkdir needs parentPath or parentId/);
    expect(writes()).toHaveLength(0);
    const ok = await callTool("mkdir", { account: "work", parentPath: "work:/", name: "AtRoot" });
    expect(ok.isError, ok.text).toBe(false);
    expect(JSON.parse(ok.text)).toMatchObject({ created: true, path: "work:/AtRoot" });
  });

  it("move without a destination is refused instead of defaulting to the inbox", async () => {
    const r = await callTool("move", { account: "work", fileId: "a" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/move needs toPath or toFolderId/);
    expect(writes()).toHaveLength(0);
  });

  it("an unknown key inside a batch item rejects the whole batch before anything runs", async () => {
    const r = await callTool("batch", {
      dryRun: false,
      operations: [
        { op: "rename", account: "work", fileId: "a", newName: "renamed.txt" },
        { op: "mkdir", account: "work", path: "work:/Projects", name: "B" },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/operations\.1: unknown argument "path" \(did you mean "parentPath"/);
    expect(writes()).toHaveLength(0);
    expect(drive.files.a!.name).toBe("notes.txt");
  });

  it("nested objects are strict too (mail saveTo), and read-only tokens get the full-access explanation", async () => {
    const full = await callTool("mail_attachment", { account: "work", messageId: "m", index: 0, saveTo: { account: "work", folder: "proj" } });
    expect(full.isError).toBe(true);
    expect(full.text).toMatch(/saveTo: unknown argument "folder" \(did you mean "folderId"/);
    const ro = await callTool("mail_attachment", { account: "work", messageId: "m", index: 0, saveTo: { account: "work" } }, false);
    expect(ro.isError).toBe(true);
    expect(ro.text).toMatch(/saveTo needs a full-access client/);
  });

  it("covers every registered tool: each advertised schema forbids additional properties", async () => {
    for (const full of [true, false]) {
      const msg = await rpc(full, "tools/list", {});
      const tools = (msg.result as { tools: { name: string; inputSchema: Record<string, unknown> }[] }).tools;
      expect(tools.length).toBeGreaterThan(full ? 40 : 15);
      for (const t of tools) expect([t.name, t.inputSchema.additionalProperties]).toEqual([t.name, false]);
    }
  });

  it("covers every registered tool at runtime: a call with an extra key is refused before its handler runs", async () => {
    for (const full of [true, false]) {
      const msg = await rpc(full, "tools/list", {});
      const names = (msg.result as { tools: { name: string }[] }).tools.map((t) => t.name);
      for (const name of names) {
        const r = await callTool(name, { zzBogus: 1 }, full);
        expect([name, r.isError, r.text]).toEqual([name, true, expect.stringContaining('unknown argument "zzBogus"')]);
      }
    }
    expect(drive.log).toHaveLength(0);
    expect(await readAudit(10)).toEqual([]);
  }, 60_000);

  it("suggests near misses", () => {
    expect(suggestKeys("path", ["account", "parentPath", "parentId", "name"])).toEqual(["parentPath"]);
    expect(suggestKeys("folder", ["account", "path", "folderId"])).toEqual(["folderId", "path"]);
    expect(suggestKeys("to", ["fromAccount", "fileId", "toAccount", "toPath", "toFolderId"])).toEqual(["toPath", "toFolderId", "toAccount"]);
    expect(suggestKeys("acount", ["account", "fileId"])).toEqual(["account"]);
    expect(suggestKeys("zzz", ["account"])).toEqual([]);
    expect(unknownKeysMessage(["zzz"], ["account"])).toBe('unknown argument "zzz"; nothing was done. Accepted arguments: account.');
  });
});
