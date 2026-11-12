/** R3-2: duplicates acrossAccounts honours path/folderId per account, pages with limit + cursor, and reports counts. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { FOLDER_MIME } from "./drive";
import { mapBounded } from "./crossdup";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";
import { registerAllTools, setDriveFetch } from "./tools";

const A = "a@example.test";
const B = "b@example.test";
const C = "c@example.test";

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const { storeMock } = await import("./testing/fakeDrive");
  return {
    ...orig,
    ...storeMock([
      { label: "alpha", email: "a@example.test" },
      { label: "beta", email: "b@example.test" },
      { label: "gamma", email: "c@example.test" },
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

const SPECS = [
  { label: "alpha", email: A },
  { label: "beta", email: B },
  { label: "gamma", email: C },
];

/**
 * alpha:/Test/small.txt (16 B) + 30 big files at the root (1000+i B)
 * beta:/Test/Inner/small.txt (16 B, same md5) + the same 30 big files at the root
 * gamma: the same 30 big files
 */
function files(): Record<string, FakeFile> {
  const f: Record<string, FakeFile> = {};
  const own = (e: string) => [{ emailAddress: e }];
  for (const [p, e] of [["a", A], ["b", B], ["c", C]] as const) f[`${p}root`] = { id: `${p}root`, name: "My Drive", mimeType: FOLDER_MIME, owners: own(e) };
  f.atest = { id: "atest", name: "Test", mimeType: FOLDER_MIME, parents: ["aroot"], owners: own(A) };
  f.btest = { id: "btest", name: "Test", mimeType: FOLDER_MIME, parents: ["broot"], owners: own(B) };
  f.binner = { id: "binner", name: "Inner", mimeType: FOLDER_MIME, parents: ["btest"], owners: own(B) };
  f.asmall = { id: "asmall", name: "small.txt", mimeType: "text/plain", parents: ["atest"], owners: own(A), size: "16", md5Checksum: "smallmd5" };
  f.bsmall = { id: "bsmall", name: "small.txt", mimeType: "text/plain", parents: ["binner"], owners: own(B), size: "16", md5Checksum: "smallmd5" };
  for (let i = 0; i < 30; i++) {
    for (const [p, e] of [["a", A], ["b", B], ["c", C]] as const) {
      f[`${p}big${i}`] = { id: `${p}big${i}`, name: `big${i}.bin`, mimeType: "application/octet-stream", parents: [`${p}root`], owners: own(e), size: String(1000 + i), md5Checksum: `big${i}` };
    }
  }
  return f;
}

let tools: Record<string, Handler>;
beforeEach(() => {
  setStore(memoryStore());
  tools = collectTools();
  setDriveFetch(fakeDrive(SPECS, files()).fetchImpl);
});
afterEach(() => {
  setDriveFetch(undefined);
  setStore(undefined);
});

describe("duplicates acrossAccounts", () => {
  it("restricts accounts to the folders given by path/paths (label:/folder) and finds small duplicates there", async () => {
    const r = await call(tools, "duplicates", { acrossAccounts: true, accounts: ["alpha", "beta"], paths: ["alpha:/Test", "beta:/Test"], minSize: 1, scope: "mine" });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({
      scopes: { alpha: "atest", beta: "btest" },
      scannedFiles: { alpha: 1, beta: 1 },
      totals: { groups: 1, files: 2 },
      page: { offset: 0, returned: 1, totalGroups: 1, hasMore: false },
      truncated: false,
    });
    const g = (r.json!.groups as { md5: string; files: { path: string }[] }[])[0]!;
    expect(g.md5).toBe("smallmd5");
    expect(g.files.map((f) => f.path).sort()).toEqual(["alpha:/Test/small.txt", "beta:/Test/Inner/small.txt"]);
  });

  it("account + folderId scopes one account; the others are scanned whole", async () => {
    const r = await call(tools, "duplicates", { acrossAccounts: true, accounts: ["alpha", "beta"], account: "alpha", folderId: "atest", minSize: 1, scope: "mine" });
    expect(r.json).toMatchObject({ scopes: { alpha: "atest" }, scannedFiles: { alpha: 1, beta: 31 }, totals: { groups: 1 } });
  });

  it("pages with limit and cursor: every group is reachable, counts are explicit, nothing is cut", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await call(tools, "duplicates", { acrossAccounts: true, minSize: 1, scope: "mine", limit: 7, ...(cursor ? { cursor } : {}) });
      expect(r.isError, r.text).toBe(false);
      const page = r.json!.page as { returned: number; totalGroups: number; hasMore: boolean; cursor?: string };
      expect(page.totalGroups).toBe(31);
      expect(r.json!.truncated).toBe(page.hasMore);
      seen.push(...(r.json!.groups as { md5: string }[]).map((g) => g.md5));
      cursor = page.cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(5);
    expect(new Set(seen).size).toBe(31);
    // Largest first; the 16-byte pair comes last but is reachable.
    expect(seen[0]).toBe("big29");
    expect(seen.at(-1)).toBe("smallmd5");
  });

  it("minSize drops the small pair; a cursor from another query is refused; a path without label is refused", async () => {
    const big = await call(tools, "duplicates", { acrossAccounts: true, minSize: 100, scope: "mine", limit: 200 });
    expect(big.json).toMatchObject({ totals: { groups: 30 }, minSize: 100 });
    const first = await call(tools, "duplicates", { acrossAccounts: true, minSize: 1, scope: "mine", limit: 5 });
    const cursor = (first.json!.page as { cursor: string }).cursor;
    const wrong = await call(tools, "duplicates", { acrossAccounts: true, minSize: 100, scope: "mine", limit: 5, cursor });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toMatch(/different duplicates query/);
    const noLabel = await call(tools, "duplicates", { acrossAccounts: true, minSize: 1, scope: "mine", path: "/Test" });
    expect(noLabel.isError).toBe(true);
    expect(noLabel.text).toMatch(/label:\/folder/);
  });
});

describe("mapBounded", () => {
  it("never runs more than n at once and keeps order and failures", async () => {
    let running = 0;
    let peak = 0;
    const r = await mapBounded([1, 2, 3, 4, 5, 6], 2, async (x) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((res) => setTimeout(res, 1));
      running--;
      if (x === 3) throw new Error("three");
      return x * 10;
    });
    expect(peak).toBe(2);
    expect(r.map((x) => (x.status === "fulfilled" ? x.value : "err"))).toEqual([10, 20, "err", 40, 50, 60]);
  });
});
