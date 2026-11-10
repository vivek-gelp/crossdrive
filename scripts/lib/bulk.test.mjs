import { describe, expect, it } from "vitest";
import {
  chunkRanges,
  csvEscape,
  drivePathFor,
  globToRegExp,
  manifestCsv,
  mimeTypeFor,
  nextOffset,
  parseArgs,
  parseDest,
  parseRpcBody,
  parseToolResult,
  shouldInclude,
  shouldSkip,
  summarize,
} from "./bulk.mjs";

describe("bulk-upload helpers", () => {
  it("parses the documented arguments", () => {
    const a = parseArgs(["--src", "C:\\data\\X", "--dest", "work:/02_Projects/Current/X", "--dry-run", "--concurrency", "4", "--include", "*.pdf,*.xlsx", "--exclude", "node_modules, *.tmp", "--manifest", "out.csv", "--allow-nonstandard-names"]);
    expect(a).toEqual({ src: "C:\\data\\X", dest: "work:/02_Projects/Current/X", dryRun: true, concurrency: 4, include: ["*.pdf", "*.xlsx"], exclude: ["node_modules", "*.tmp"], manifest: "out.csv", allowNonstandardNames: true });
    expect(parseArgs(["--src", "a", "--dest", "b:/c"]).concurrency).toBe(3);
    expect(() => parseArgs(["--src", "a"])).toThrow(/--src and --dest are required/);
    expect(() => parseArgs(["--src", "a", "--dest", "b", "--concurrency", "0"])).toThrow(/between 1 and 16/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument --bogus/);
  });

  it("splits the destination into account, parent path and leaf name", () => {
    expect(parseDest("work:/02_Projects/Current/X")).toEqual({ account: "work", path: "work:/02_Projects/Current/X", parentPath: "work:/02_Projects/Current", name: "X" });
    expect(parseDest("personal:/99_Inbox_To_File")).toEqual({ account: "personal", path: "personal:/99_Inbox_To_File", parentPath: "personal:/", name: "99_Inbox_To_File" });
    expect(parseDest("work:drive/Finance/2026")).toEqual({ account: "work", path: "work:drive/Finance/2026", parentPath: "work:drive/Finance", name: "2026" });
    expect(parseDest("work:~shared/Top/Sub")).toMatchObject({ parentPath: "work:~shared/Top", name: "Sub" });
    expect(() => parseDest("/no/label")).toThrow(/label:\/Folder/);
    expect(() => parseDest("work:/")).toThrow(/below the root/);
  });

  it("matches include/exclude globs against path segments", () => {
    expect(globToRegExp("*.PDF").test("deck.pdf")).toBe(true);
    expect(globToRegExp("a?c").test("abc")).toBe(true);
    expect(globToRegExp("a.c").test("abc")).toBe(false);
    const f = { include: ["*.pdf", "*.xlsx"], exclude: ["node_modules", "*.tmp", ".git"] };
    expect(shouldInclude("docs/2026-01-01_Acme_Deck.pdf", f)).toBe(true);
    expect(shouldInclude("docs\\sheet.xlsx", f)).toBe(true);
    expect(shouldInclude("docs/notes.txt", f)).toBe(false);
    expect(shouldInclude("node_modules/x/y.pdf", f)).toBe(false);
    expect(shouldInclude("docs/scratch.tmp", f)).toBe(false);
    expect(shouldInclude(".git/HEAD.pdf", f)).toBe(false);
    expect(shouldInclude("anything.bin")).toBe(true);
    expect(shouldInclude("anything.bin", { exclude: ["*.bin"] })).toBe(false);
  });

  it("skips files already present with the same name and size", () => {
    const remote = new Map([
      ["a.pdf", { id: "1", size: 10, mimeType: "application/pdf" }],
      ["b.pdf", { id: "2", size: 11, mimeType: "application/pdf" }],
      ["Folder", { id: "3", mimeType: "application/vnd.google-apps.folder" }],
      ["g.doc", { id: "4", mimeType: "application/vnd.google-apps.document" }],
    ]);
    expect(shouldSkip({ name: "a.pdf", size: 10 }, remote)).toBe(true);
    expect(shouldSkip({ name: "b.pdf", size: 10 }, remote)).toBe(false);
    expect(shouldSkip({ name: "c.pdf", size: 10 }, remote)).toBe(false);
    expect(shouldSkip({ name: "Folder", size: 10 }, remote)).toBe(false);
    expect(shouldSkip({ name: "g.doc", size: 10 }, remote)).toBe(true);
  });

  it("computes 256 KiB-aligned chunk ranges and resume offsets", () => {
    const MB8 = 8 * 1024 * 1024;
    expect(chunkRanges(0)).toEqual([[0, -1]]);
    expect(chunkRanges(5)).toEqual([[0, 4]]);
    expect(chunkRanges(MB8)).toEqual([[0, MB8 - 1]]);
    expect(chunkRanges(MB8 + 1)).toEqual([
      [0, MB8 - 1],
      [MB8, MB8],
    ]);
    expect(chunkRanges(3 * MB8 + 7, MB8).length).toBe(4);
    expect(() => chunkRanges(10, 1000)).toThrow(/256 KiB/);
    expect(nextOffset(null)).toBe(0);
    expect(nextOffset("bytes=0-262143")).toBe(262144);
    expect(nextOffset("garbage")).toBe(0);
  });

  it("guesses mime types by extension", () => {
    expect(mimeTypeFor("x.PDF")).toBe("application/pdf");
    expect(mimeTypeFor("x.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimeTypeFor("x.unknown")).toBe("application/octet-stream");
    expect(mimeTypeFor("noext")).toBe("application/octet-stream");
  });

  it("writes the manifest CSV with escaping and summarises it", () => {
    const rows = [
      { localPath: "C:\\d\\a.pdf", drivePath: "work:/X/a.pdf", fileId: "f1", status: "uploaded", bytes: 10, message: "" },
      { localPath: "C:\\d\\b, \"c\".pdf", drivePath: "work:/X/b, \"c\".pdf", fileId: "", status: "skipped", bytes: 5, message: "same name and size" },
      { localPath: "C:\\d\\e.pdf", drivePath: "work:/X/e.pdf", fileId: "", status: "error", bytes: 7, message: "naming rule\nline2" },
    ];
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(manifestCsv(rows)).toBe(
      "localPath,drivePath,fileId,status,bytes,message\r\n" +
        "C:\\d\\a.pdf,work:/X/a.pdf,f1,uploaded,10,\r\n" +
        '"C:\\d\\b, ""c"".pdf","work:/X/b, ""c"".pdf",,skipped,5,same name and size\r\n' +
        'C:\\d\\e.pdf,work:/X/e.pdf,,error,7,"naming rule\nline2"\r\n',
    );
    expect(summarize(rows)).toEqual({ uploaded: 1, skipped: 1, error: 1, planned: 0, bytesUploaded: 10, bytesPlanned: 0 });
    expect(summarize([{ status: "planned", bytes: 3 }])).toMatchObject({ planned: 1, bytesPlanned: 3 });
  });

  it("builds drive paths and parses MCP responses", () => {
    expect(drivePathFor("work:/X", "sub\\dir/a.pdf")).toBe("work:/X/sub/dir/a.pdf");
    expect(drivePathFor("work:/X/", "")).toBe("work:/X/");
    expect(parseToolResult({ result: { content: [{ type: "text", text: '{"a":1}' }] } })).toEqual({ a: 1 });
    expect(() => parseToolResult({ result: { isError: true, content: [{ type: "text", text: "boom" }] } })).toThrow("boom");
    expect(() => parseToolResult({ error: { code: -32601, message: "no such tool" } })).toThrow(/MCP error -32601/);
    expect(parseRpcBody("application/json", '{"id":1,"result":{}}')).toEqual([{ id: 1, result: {} }]);
    expect(parseRpcBody("text/event-stream", 'event: message\ndata: {"id":1,"result":{"x":1}}\n\n: ping\n\ndata: {"id":2}\n\n')).toEqual([{ id: 1, result: { x: 1 } }, { id: 2 }]);
    expect(parseRpcBody("application/json", "")).toEqual([]);
  });
});
