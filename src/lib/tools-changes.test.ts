import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { FOLDER_MIME } from "./drive";
import { parseSince } from "./changes";
import { registerAllTools, setDriveFetch } from "./tools";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";

const WORK = "alex@acme.example";
const PERSONAL = "alex.example@gmail.com";
const TEAM = "team@acme.example";
const SPECS = [
  { label: "work", email: WORK, drives: [{ id: "d1", name: "Finance" }] },
  { label: "personal", email: PERSONAL },
];

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

describe("parseSince", () => {
  const now = new Date("2026-11-09T12:00:00.000Z");
  it("understands relative spans", () => {
    expect(parseSince("24h", now)).toBe("2026-11-08T12:00:00.000Z");
    expect(parseSince("7d", now)).toBe("2026-11-02T12:00:00.000Z");
    expect(parseSince("2w", now)).toBe("2026-10-26T12:00:00.000Z");
    expect(parseSince("30min", now)).toBe("2026-11-09T11:30:00.000Z");
    expect(parseSince(" 1 D ", now)).toBe("2026-11-08T12:00:00.000Z");
  });
  it("understands dates and timestamps", () => {
    expect(parseSince("2026-11-01", now)).toBe("2026-11-01T00:00:00.000Z");
    expect(parseSince("2026-11-01T09:30:00+05:30", now)).toBe("2026-11-01T04:00:00.000Z");
  });
  it("rejects garbage with a helpful message", () => {
    expect(() => parseSince("yesterday", now)).toThrow(/24h, 7d or 2w/);
  });
});

describe("changes tool", () => {
  type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  let tools: Record<string, Handler>;
  beforeEach(() => {
    setStore(memoryStore());
    tools = {};
    const server = { registerTool: (name: string, _d: unknown, h: Handler) => void (tools[name] = h) } as unknown as McpServer;
    registerAllTools(server);
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  function files(): Record<string, FakeFile> {
    return {
      root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: WORK }] },
      co: { id: "co", name: "01_Company", mimeType: FOLDER_MIME, parents: ["root"], owners: [{ emailAddress: WORK }], modifiedTime: "2026-11-08T10:00:00.000Z" },
      old: { id: "old", name: "Old.pdf", mimeType: "application/pdf", parents: ["co"], owners: [{ emailAddress: WORK }], modifiedTime: "2026-10-01T00:00:00.000Z" },
      s1: { id: "s1", name: "2026-11-09_Acme_Deck.pdf", mimeType: "application/pdf", parents: ["co"], owners: [{ emailAddress: WORK }], modifiedTime: "2026-11-09T09:00:00.000Z" },
      sh: { id: "sh", name: "Plan.docx", mimeType: "application/msword", owners: [{ emailAddress: TEAM }], perms: { [WORK]: "reader" }, sharedWithMe: true, modifiedTime: "2026-11-09T08:00:00.000Z" },
      d1: { id: "d1", name: "Finance", mimeType: FOLDER_MIME, driveId: "d1" },
      inv: { id: "inv", name: "Invoice.pdf", mimeType: "application/pdf", parents: ["d1"], driveId: "d1", modifiedTime: "2026-11-09T07:00:00.000Z" },
      proot: { id: "proot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: PERSONAL }] },
      p1: { id: "p1", name: "2026-11-09_Personal_Idea.md", mimeType: "text/markdown", parents: ["proot"], owners: [{ emailAddress: PERSONAL }], modifiedTime: "2026-11-09T10:00:00.000Z" },
    };
  }

  async function run(args: Record<string, unknown>) {
    const r = await tools.changes!(args, {} as ServerContext);
    return { isError: r.isError === true, text: r.content[0]?.text ?? "", json: r.isError ? undefined : (JSON.parse(r.content[0]!.text) as Record<string, unknown>) };
  }

  it("merges recent changes across all accounts newest first with owner, shared and path", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await run({ since: "2026-11-07T00:00:00Z", limit: 50, includeShared: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.json!.since).toBe("2026-11-07T00:00:00.000Z");
    expect(r.json!.accounts).toEqual(["work", "personal"]);
    const results = r.json!.results as Record<string, unknown>[];
    expect(results.map((x) => [x.account, x.id])).toEqual([
      ["personal", "p1"],
      ["work", "s1"],
      ["work", "sh"],
      ["work", "inv"],
      ["work", "co"],
    ]);
    expect(results[2]).toMatchObject({ owner: TEAM, shared: true, canEdit: false, path: "work:~shared/Plan.docx" });
    expect(results[3]).toMatchObject({ path: "work:drive/Finance/Invoice.pdf" });
    expect(r.json!.perAccount).toEqual({ work: 4, personal: 1 });
    const q = b.log.find((l) => l.path === "/drive/v3/files" && l.method === "GET")!;
    expect(q.params.get("q")).toContain("modifiedTime > '2026-11-07T00:00:00.000Z'");
    expect(q.params.get("q")).toContain("trashed = false");
    expect(q.params.get("orderBy")).toBe("modifiedTime desc");
    expect(q.params.get("pageSize")).toBe("50");
    expect(b.log.filter((l) => l.method !== "GET")).toHaveLength(0);
  });

  it("limits accounts, applies limit and includeShared=false", async () => {
    const b = fakeDrive(SPECS, files());
    setDriveFetch(b.fetchImpl);
    const r = await run({ accounts: ["work"], since: "7d", limit: 2, includeShared: false });
    expect(r.isError, r.text).toBe(false);
    const results = r.json!.results as Record<string, unknown>[];
    expect(results.map((x) => x.id)).toEqual(["s1", "co"]);
    expect(b.queries.at(-1)).toContain("'me' in owners");

    const bad = await run({ accounts: ["family"], since: "7d", limit: 50, includeShared: true });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Not connected: family/);
    const garbage = await run({ since: "last tuesday", limit: 50, includeShared: true });
    expect(garbage.isError).toBe(true);
  });
});
