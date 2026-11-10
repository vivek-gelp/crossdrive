import { describe, expect, it, vi } from "vitest";
import { parsePathArg, resolvePath, resolveSharedPath, resolveDrivePath, PathResolver, SHARED_PREFIX, DRIVE_PREFIX } from "./paths";
import { DriveClient, FOLDER_MIME, type DriveFile } from "./drive";

function fakeDrive(tree: Record<string, DriveFile[]>): DriveClient {
  return {
    listChildren: vi.fn(async (parentId: string) => ({ files: tree[parentId] ?? [] })),
  } as unknown as DriveClient;
}

const folder = (id: string, name: string, parent: string): DriveFile => ({
  id,
  name,
  mimeType: "application/vnd.google-apps.folder",
  parents: [parent],
});

describe("parsePathArg", () => {
  it("splits label:/a/b into label and segments", () => {
    expect(parsePathArg("work:/01_Company/Sub")).toEqual({ label: "work", segments: ["01_Company", "Sub"], shared: false, drive: false });
  });
  it("accepts path without label and ignores trailing or doubled slashes", () => {
    expect(parsePathArg("/01_Company//Sub/")).toEqual({ label: undefined, segments: ["01_Company", "Sub"], shared: false, drive: false });
    expect(parsePathArg("")).toEqual({ label: undefined, segments: [], shared: false, drive: false });
    expect(parsePathArg("/")).toEqual({ label: undefined, segments: [], shared: false, drive: false });
  });
  it("recognises the ~shared form in all its spellings", () => {
    expect(SHARED_PREFIX).toBe("~shared");
    expect(parsePathArg("work:~shared/Northwind Phase I - All Details/Sub")).toEqual({
      label: "work",
      segments: ["Northwind Phase I - All Details", "Sub"],
      shared: true,
      drive: false,
    });
    expect(parsePathArg("work:/~shared/Top")).toEqual({ label: "work", segments: ["Top"], shared: true, drive: false });
    expect(parsePathArg("~Shared/Top/")).toEqual({ label: undefined, segments: ["Top"], shared: true, drive: false });
    expect(parsePathArg("work:~shared")).toEqual({ label: "work", segments: [], shared: true, drive: false });
  });
  it("rejects .. segments", () => {
    expect(() => parsePathArg("work:/a/../b")).toThrow(/\.\./);
  });
});

describe("resolvePath", () => {
  const drive = fakeDrive({
    root: [folder("f1", "01_Company", "root"), folder("f9", "99_Inbox_To_File", "root")],
    f1: [folder("f2", "Sub", "f1")],
  });

  it("walks folder names from root", async () => {
    expect(await resolvePath(drive, ["01_Company", "Sub"])).toBe("f2");
    expect(await resolvePath(drive, [])).toBe("root");
  });
  it("throws a clear error for a missing segment", async () => {
    await expect(resolvePath(drive, ["01_Company", "Nope"])).rejects.toThrow(/Nope/);
  });
  it("matches folder names case-insensitively", async () => {
    expect(await resolvePath(drive, ["01_company", "sub"])).toBe("f2");
  });
});

describe("PathResolver cache", () => {
  it("caches resolutions for 5 minutes per account", async () => {
    const drive = fakeDrive({ root: [folder("f1", "A", "root")] });
    let now = 1_000_000;
    const r = new PathResolver(() => now);
    expect(await r.resolve("work", drive, ["A"])).toBe("f1");
    expect(await r.resolve("work", drive, ["A"])).toBe("f1");
    expect(drive.listChildren).toHaveBeenCalledTimes(1);
    now += 5 * 60 * 1000 + 1;
    expect(await r.resolve("work", drive, ["A"])).toBe("f1");
    expect(drive.listChildren).toHaveBeenCalledTimes(2);
  });
  it("builds a display path for a file from its parents chain", async () => {
    const drive = fakeDrive({ root: [folder("f1", "A", "root")], f1: [folder("f2", "B", "f1")] });
    const meta = vi.fn(async (id: string) =>
      id === "f2"
        ? folder("f2", "B", "f1")
        : id === "f1"
          ? folder("f1", "A", "root")
          : { id: "root", name: "My Drive", mimeType: "application/vnd.google-apps.folder" },
    );
    (drive as unknown as { getFile: typeof meta }).getFile = meta;
    const r = new PathResolver(() => 0);
    expect(await r.displayPath("work", drive, "f2", "root")).toBe("work:/A/B");
  });
});

/**
 * A fake Drive REST backend: answers files.list by inspecting the `q` string,
 * so the resolver is exercised through the real DriveClient query builder.
 */
function sharedBackend() {
  const top: DriveFile = {
    id: "top1",
    name: "Northwind Phase I - All Details",
    mimeType: FOLDER_MIME,
    owners: [{ emailAddress: "team@acme.example" }],
  };
  const sub: DriveFile = { id: "sub1", name: "Land", mimeType: FOLDER_MIME, parents: ["top1"], owners: top.owners };
  const doc: DriveFile = { id: "doc1", name: "Survey.pdf", mimeType: "application/pdf", parents: ["sub1"], owners: top.owners };
  const byId: Record<string, DriveFile> = { top1: top, sub1: sub, doc1: doc };
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const q = url.searchParams.get("q") ?? "";
    let files: DriveFile[] = [];
    if (q.includes("sharedWithMe = true")) files = q.includes("name contains") ? [top] : [top];
    else if (q.includes("'top1' in parents")) files = [sub];
    else if (q.includes("'sub1' in parents")) files = [doc];
    else if (url.pathname.startsWith("/drive/v3/files/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      const f = byId[id];
      if (!f) return new Response(JSON.stringify({ error: { message: "File not found" } }), { status: 404 });
      return new Response(JSON.stringify(f), { status: 200 });
    }
    return new Response(JSON.stringify({ files }), { status: 200 });
  });
  return { drive: new DriveClient("tok", fetchImpl as unknown as typeof fetch), fetchImpl };
}

describe("resolveSharedPath", () => {
  it("finds the top folder among shared-with-me folders by name, then walks children", async () => {
    const { drive, fetchImpl } = sharedBackend();
    expect(await resolveSharedPath(drive, ["Northwind Phase I - All Details"])).toBe("top1");
    expect(await resolveSharedPath(drive, ["northwind phase i - all details", "land"])).toBe("sub1");
    const firstQ = new URL(String(fetchImpl.mock.calls[0]?.[0])).searchParams.get("q") ?? "";
    expect(firstQ).toContain("sharedWithMe = true");
    expect(firstQ).toContain(`mimeType = '${FOLDER_MIME}'`);
  });
  it("explains when the top folder is not shared with the account", async () => {
    const { drive } = sharedBackend();
    await expect(resolveSharedPath(drive, ["Proposals"])).rejects.toThrow(/"Proposals".*shared with/);
    await expect(resolveSharedPath(drive, [])).rejects.toThrow(/~shared/);
  });
  it("is reachable through PathResolver.resolve with shared=true and cached separately", async () => {
    const { drive, fetchImpl } = sharedBackend();
    const r = new PathResolver(() => 0);
    expect(await r.resolve("work", drive, ["Northwind Phase I - All Details", "Land"], "root", true)).toBe("sub1");
    const calls = fetchImpl.mock.calls.length;
    expect(await r.resolve("work", drive, ["Northwind Phase I - All Details", "Land"], "root", true)).toBe("sub1");
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });
});

describe("displayPath for shared items", () => {
  it("prefixes ~shared when the parents chain does not reach My Drive root", async () => {
    const { drive } = sharedBackend();
    const r = new PathResolver(() => 0);
    expect(await r.displayPath("work", drive, "doc1", "root")).toBe("work:~shared/Northwind Phase I - All Details/Land/Survey.pdf");
    expect(await r.displayPath("work", drive, "top1", "root")).toBe("work:~shared/Northwind Phase I - All Details");
  });
  it("prefixes ~shared when a parent is not accessible to the account", async () => {
    const { drive } = sharedBackend();
    const r = new PathResolver(() => 0);
    const orphan: DriveFile = { id: "x", name: "Deck.pptx", mimeType: "x", parents: ["hidden"], owners: [{ emailAddress: "a@b.c" }] };
    expect(await r.displayPath("work", drive, "x", "root", orphan)).toBe("work:~shared/Deck.pptx");
  });
});

describe("Shared Drive paths (label:drive/<Drive name>/Sub)", () => {
  it("parsePathArg recognises the drive form", () => {
    expect(DRIVE_PREFIX).toBe("drive");
    expect(parsePathArg("work:drive/Finance/2026")).toEqual({ label: "work", segments: ["Finance", "2026"], shared: false, drive: true });
    expect(parsePathArg("work:/drive/Finance")).toEqual({ label: "work", segments: ["Finance"], shared: false, drive: true });
    expect(parsePathArg("Drive/Finance")).toEqual({ label: undefined, segments: ["Finance"], shared: false, drive: true });
    expect(parsePathArg("work:drive")).toEqual({ label: "work", segments: [], shared: false, drive: true });
    expect(parsePathArg("work:/A")).toMatchObject({ drive: false, shared: false });
    expect(parsePathArg("work:~shared/Top")).toMatchObject({ drive: false, shared: true });
  });

  function driveBackend() {
    const root: DriveFile = { id: "d1", name: "Finance", mimeType: FOLDER_MIME, driveId: "d1" };
    const sub: DriveFile = { id: "y26", name: "2026", mimeType: FOLDER_MIME, parents: ["d1"], driveId: "d1" };
    const doc: DriveFile = { id: "inv", name: "Invoice.pdf", mimeType: "application/pdf", parents: ["y26"], driveId: "d1" };
    const byId: Record<string, DriveFile> = { d1: root, y26: sub, inv: doc };
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const q = url.searchParams.get("q") ?? "";
      if (url.pathname === "/drive/v3/drives") {
        return new Response(JSON.stringify({ drives: [{ id: "d1", name: "Finance" }, { id: "d2", name: "Projects" }] }), { status: 200 });
      }
      let files: DriveFile[] = [];
      if (q.includes("'d1' in parents")) files = [sub];
      else if (q.includes("'y26' in parents")) files = [doc];
      else if (url.pathname.startsWith("/drive/v3/files/")) {
        const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
        const f = byId[id];
        if (!f) return new Response(JSON.stringify({ error: { message: "File not found" } }), { status: 404 });
        return new Response(JSON.stringify(f), { status: 200 });
      }
      return new Response(JSON.stringify({ files }), { status: 200 });
    });
    return { drive: new DriveClient("tok", fetchImpl as unknown as typeof fetch), fetchImpl };
  }

  it("resolveDrivePath matches the drive by name (case-insensitive) then walks folders", async () => {
    const { drive } = driveBackend();
    expect(await resolveDrivePath(drive, ["Finance"])).toBe("d1");
    expect(await resolveDrivePath(drive, ["finance", "2026"])).toBe("y26");
    await expect(resolveDrivePath(drive, ["Nope"])).rejects.toThrow(/"Nope".*Shared Drive/);
    await expect(resolveDrivePath(drive, [])).rejects.toThrow(/drive\//);
  });

  it("is reachable through PathResolver.resolve with drive=true", async () => {
    const { drive, fetchImpl } = driveBackend();
    const r = new PathResolver(() => 0);
    expect(await r.resolve("work", drive, ["Finance", "2026"], "root", false, true)).toBe("y26");
    const calls = fetchImpl.mock.calls.length;
    expect(await r.resolve("work", drive, ["Finance", "2026"], "root", false, true)).toBe("y26");
    expect(fetchImpl.mock.calls.length).toBe(calls);
  });

  it("displayPath emits label:drive/<Drive name>/... for Shared Drive items", async () => {
    const { drive } = driveBackend();
    const r = new PathResolver(() => 0);
    expect(await r.displayPath("work", drive, "inv", "root")).toBe("work:drive/Finance/2026/Invoice.pdf");
    expect(await r.displayPath("work", drive, "d1", "root")).toBe("work:drive/Finance");
  });
});
