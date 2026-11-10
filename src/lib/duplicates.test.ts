import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { DriveClient, FOLDER_MIME, type DriveFile } from "./drive";
import { collectSubtreeFolders, groupDuplicates, MAX_GROUPS, MAX_SCAN_PAGES, pickKeep, scanFiles } from "./duplicates";
import { registerAllTools, setDriveFetch } from "./tools";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";

const WORK = "alex@acme.example";
const TEAM = "team@acme.example";
const DOC = "application/vnd.google-apps.document";

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const { storeMock } = await import("./testing/fakeDrive");
  return { ...orig, ...storeMock([{ label: "work", email: "alex@acme.example" }]) };
});

const file = (id: string, name: string, extra: Partial<DriveFile> = {}): DriveFile => ({ id, name, mimeType: "application/pdf", ...extra });

describe("groupDuplicates", () => {
  it("groups by md5, then by (name, size) for Google-native files, ignoring singletons and folders", () => {
    const groups = groupDuplicates(
      [
        file("a", "x.pdf", { md5Checksum: "m1", size: "10" }),
        file("b", "y.pdf", { md5Checksum: "m1", size: "10" }),
        file("c", "z.pdf", { md5Checksum: "m2", size: "10" }),
        file("d", "Notes", { mimeType: DOC, size: "7" }),
        file("e", "Notes", { mimeType: DOC, size: "7" }),
        file("f", "Notes", { mimeType: DOC, size: "8" }),
        file("g", "Folder", { mimeType: FOLDER_MIME }),
        file("h", "Folder", { mimeType: FOLDER_MIME }),
        file("i", "nochecksum.bin", { size: "3" }),
        file("j", "nochecksum.bin", { size: "3" }),
      ],
      1,
    );
    expect(groups.map((g) => g.map((f) => f.id))).toEqual([
      ["a", "b"],
      ["d", "e"],
    ]);
  });
  it("applies minSize to files with a known size only", () => {
    const groups = groupDuplicates(
      [file("a", "s.pdf", { md5Checksum: "m", size: "5" }), file("b", "s.pdf", { md5Checksum: "m", size: "5" }), file("c", "Doc", { mimeType: DOC }), file("d", "Doc", { mimeType: DOC })],
      100,
    );
    expect(groups.map((g) => g.map((f) => f.id))).toEqual([["c", "d"]]);
  });
});

describe("pickKeep", () => {
  it("prefers the shortest path, then the oldest file", () => {
    expect(
      pickKeep([
        { id: "deep", path: "a:/x/y/z/f.pdf", modifiedTime: "2020-01-01T00:00:00Z" },
        { id: "new", path: "a:/x/f.pdf", modifiedTime: "2026-01-01T00:00:00Z" },
        { id: "old", path: "a:/y/f.pdf", modifiedTime: "2021-01-01T00:00:00Z" },
      ]).id,
    ).toBe("old");
  });
});

describe("scanFiles and collectSubtreeFolders", () => {
  function pagedDrive(pages: DriveFile[][]) {
    const params: URLSearchParams[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      params.push(url.searchParams);
      const i = call++;
      const body = { files: pages[Math.min(i, pages.length - 1)] ?? [], nextPageToken: i + 1 < pages.length ? `p${i + 1}` : undefined };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    return { drive: new DriveClient("tok", fetchImpl as unknown as typeof fetch), params, fetchImpl };
  }

  it("scope=mine adds 'me' in owners, excludes folders and trashed, pageSize 1000, stops at the page cap", async () => {
    const pages = Array.from({ length: MAX_SCAN_PAGES + 5 }, (_, i) => [file(`f${i}`, `f${i}.pdf`)]);
    const { drive, params } = pagedDrive(pages);
    const r = await scanFiles(drive, { scope: "mine" });
    expect(r.truncated).toBe(true);
    expect(r.files).toHaveLength(MAX_SCAN_PAGES);
    expect(params).toHaveLength(MAX_SCAN_PAGES);
    const q = params[0]!.get("q")!;
    expect(q).toContain("trashed = false");
    expect(q).toContain("'me' in owners");
    expect(q).toContain(`mimeType != '${FOLDER_MIME}'`);
    expect(params[0]!.get("pageSize")).toBe("1000");
    expect(params[1]!.get("pageToken")).toBe("p1");
  });

  it("scope=all does not restrict owners and restricts to the given parents", async () => {
    const { drive, params } = pagedDrive([[file("a", "a.pdf")]]);
    const r = await scanFiles(drive, { scope: "all", parentIds: ["p1", "p2"] });
    expect(r.truncated).toBe(false);
    const q = params[0]!.get("q")!;
    expect(q).not.toContain("owners");
    expect(q).toContain("('p1' in parents or 'p2' in parents)");
  });

  it("collectSubtreeFolders walks breadth-first and honours the cap", async () => {
    const tree: Record<string, string[]> = { r: ["a", "b"], a: ["c"], b: [], c: [] };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const q = url.searchParams.get("q") ?? "";
      const parents = [...q.matchAll(/'([^']+)' in parents/g)].map((m) => m[1]!);
      const files = parents.flatMap((p) => (tree[p] ?? []).map((id) => ({ id, name: id, mimeType: FOLDER_MIME })));
      expect(q).toContain(`mimeType = '${FOLDER_MIME}'`);
      return new Response(JSON.stringify({ files }), { status: 200 });
    });
    const drive = new DriveClient("tok", fetchImpl as unknown as typeof fetch);
    expect(await collectSubtreeFolders(drive, "r")).toEqual({ ids: ["r", "a", "b", "c"], truncated: false });
    expect(await collectSubtreeFolders(drive, "r", 2)).toEqual({ ids: ["r", "a"], truncated: true });
  });
});

describe("duplicates tool", () => {
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
    const own = { owners: [{ emailAddress: WORK }] };
    return {
      root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, ...own },
      co: { id: "co", name: "01_Company", mimeType: FOLDER_MIME, parents: ["root"], ...own },
      deep: { id: "deep", name: "Archive", mimeType: FOLDER_MIME, parents: ["co"], ...own },
      inbox: { id: "inbox", name: "99_Inbox_To_File", mimeType: FOLDER_MIME, parents: ["root"], ...own },
      r1: { id: "r1", name: "Report.pdf", mimeType: "application/pdf", parents: ["co"], md5Checksum: "m1", size: "1000", modifiedTime: "2026-01-01T00:00:00Z", ...own },
      r2: { id: "r2", name: "Report (1).pdf", mimeType: "application/pdf", parents: ["inbox"], md5Checksum: "m1", size: "1000", modifiedTime: "2026-02-01T00:00:00Z", ...own },
      r3: { id: "r3", name: "Report.pdf", mimeType: "application/pdf", parents: ["deep"], md5Checksum: "m1", size: "1000", modifiedTime: "2025-01-01T00:00:00Z", ...own },
      d1: { id: "d1", name: "Minutes", mimeType: DOC, parents: ["co"], size: "50", modifiedTime: "2026-01-01T00:00:00Z", ...own },
      d2: { id: "d2", name: "Minutes", mimeType: DOC, parents: ["inbox"], size: "50", modifiedTime: "2026-03-01T00:00:00Z", ...own },
      only: { id: "only", name: "Unique.pdf", mimeType: "application/pdf", parents: ["co"], md5Checksum: "u", size: "9", ...own },
      // Shared by TEAM, same checksum as r1: only seen with scope=all.
      sh: { id: "sh", name: "Report.pdf", mimeType: "application/pdf", md5Checksum: "m1", size: "1000", owners: [{ emailAddress: TEAM }], perms: { [WORK]: "reader" }, sharedWithMe: true },
    };
  }

  it("returns groups sorted by wasted bytes with paths, suggestedKeep and totals", async () => {
    const b = fakeDrive([{ label: "work", email: WORK }], files());
    setDriveFetch(b.fetchImpl);
    const r = await tools.duplicates!({ account: "work", scope: "mine", minSize: 1 }, {} as ServerContext);
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    const out = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    expect(out).toMatchObject({ account: "work", scope: "mine", scannedFiles: 6, scanTruncated: false, truncated: false, totals: { groups: 2, duplicateFiles: 3, wastedBytes: 2050 } });
    const groups = out.groups as Record<string, unknown>[];
    expect(groups[0]).toMatchObject({ key: "md5:m1", count: 3, size: 1000, wastedBytes: 2000, suggestedKeep: "r1" });
    // Files are listed shortest path first (the suggested keep leads), then by age.
    expect((groups[0]!.files as Record<string, unknown>[]).map((f) => f.path)).toEqual([
      "work:/01_Company/Report.pdf",
      "work:/01_Company/Archive/Report.pdf",
      "work:/99_Inbox_To_File/Report (1).pdf",
    ]);
    expect((groups[0]!.files as Record<string, unknown>[])[0]).toMatchObject({ id: "r1", owner: "me", modifiedTime: "2026-01-01T00:00:00Z" });
    expect(groups[1]).toMatchObject({ key: "name:Minutes|50", count: 2, wastedBytes: 50, suggestedKeep: "d1" });
    expect(b.queries[0]).toContain("'me' in owners");
  });

  it("scope=all includes shared items and path restricts to a subtree", async () => {
    const b = fakeDrive([{ label: "work", email: WORK }], files());
    setDriveFetch(b.fetchImpl);
    const all = JSON.parse((await tools.duplicates!({ account: "work", scope: "all", minSize: 1 }, {} as ServerContext)).content[0]!.text) as Record<string, unknown>;
    expect((all.groups as Record<string, unknown>[])[0]).toMatchObject({ count: 4 });
    expect((all.groups as Record<string, unknown>[])[0]!.files).toContainEqual(expect.objectContaining({ id: "sh", owner: TEAM, path: "work:~shared/Report.pdf" }));

    const sub = JSON.parse((await tools.duplicates!({ account: "work", scope: "mine", path: "work:/01_Company", minSize: 1 }, {} as ServerContext)).content[0]!.text) as Record<string, unknown>;
    expect(sub.totals).toEqual({ groups: 1, duplicateFiles: 1, wastedBytes: 1000 });
    expect(((sub.groups as Record<string, unknown>[])[0]!.files as Record<string, unknown>[]).map((f) => f.id)).toEqual(["r1", "r3"]);
    expect(b.queries.some((q) => q.includes("'co' in parents or 'deep' in parents"))).toBe(true);
    expect(MAX_GROUPS).toBe(200);
  });
});
