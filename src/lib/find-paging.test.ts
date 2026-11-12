import { describe, expect, it, vi } from "vitest";
import type { DriveFile, DriveList } from "./drive";

/**
 * Drive answers full-text queries in relevance order and can repeat an item on consecutive pages. find must sort each
 * page newest first, never return an item twice across pages, and resume a cut page exactly.
 */

const pages: Record<string, Record<string, DriveList>> = {};

vi.mock("./ctx", () => ({
  ctxFor: async (label: string) => ({
    account: { label },
    rootId: "root",
    ownEmail: `${label}@example.com`,
    drive: {
      searchPage: async (o: { pageToken?: string }) => pages[label]![o.pageToken ?? "first"] ?? { files: [] },
    },
  }),
  folderFromPath: async () => "root",
  toResult: async (c: { account: { label: string } }, f: DriveFile) => ({ account: c.account.label, id: f.id, name: f.name, modifiedTime: f.modifiedTime }),
}));

const { findAcross, decodeCursor } = await import("./find");

const file = (id: string, day: number): DriveFile => ({ id, name: `${id}.pdf`, mimeType: "application/pdf", modifiedTime: `2023-01-${String(day).padStart(2, "0")}T00:00:00.000Z` });

describe("find paging", () => {
  it("sorts each page newest first and drops an item Drive repeats on the next page", async () => {
    // Relevance order from Drive: a 2021-style mix, and f3 appears on both pages.
    pages.personal = {
      first: { files: [file("f1", 2), file("f2", 9), file("f3", 5)], nextPageToken: "p2" },
      p2: { files: [file("f3", 5), file("f4", 20), file("f5", 1)] },
    };
    const one = await findAcross(["personal"], { query: "invoice", limit: 3 });
    expect(one.results.map((r) => r.id)).toEqual(["f2", "f3", "f1"]);
    expect(one.hasMore).toBe(true);
    const two = await findAcross(["personal"], { query: "invoice", limit: 3, pageToken: one.nextPageToken });
    expect(two.results.map((r) => r.id)).toEqual(["f4", "f5"]);
    expect(two.hasMore).toBe(false);
  });

  it("resumes a page cut by the merge without skipping or repeating, across accounts", async () => {
    pages.personal = { first: { files: [file("p1", 1), file("p2", 30), file("p3", 15)] } };
    pages.work = { first: { files: [file("w1", 20), file("w2", 10), file("w3", 25)] } };
    const seen: string[] = [];
    let token: string | undefined;
    do {
      const r = await findAcross(["personal", "work"], { query: "x", limit: 2, pageToken: token });
      seen.push(...r.results.map((x) => x.id));
      token = r.nextPageToken;
    } while (token);
    expect(seen).toEqual(["p2", "w3", "w1", "p3", "w2", "p1"]);
  });

  it("accepts cursors from before 1.0.1 (no seen list) and keeps the token bounded", async () => {
    pages.personal = { first: { files: [file("a", 1), file("b", 2)] }, next: { files: [file("c", 3)] } };
    const legacy = Buffer.from(JSON.stringify({ v: 1, p: 2, a: { personal: { t: "next", s: 0 } } })).toString("base64url");
    const r = await findAcross(["personal"], { query: "x", limit: 2, pageToken: legacy });
    expect(r.results.map((x) => x.id)).toEqual(["c"]);
    pages.personal = { first: { files: Array.from({ length: 100 }, (_, i) => file(`m${i}`, (i % 28) + 1)), nextPageToken: "more" } };
    const big = await findAcross(["personal"], { query: "x", limit: 100 });
    expect(decodeCursor(big.nextPageToken!).x).toHaveLength(100);
    expect(big.nextPageToken!.length).toBeLessThan(3000);
  });
});
