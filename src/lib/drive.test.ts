import { describe, expect, it, vi } from "vitest";
import { DriveClient, FILE_FIELDS, FOLDER_MIME, SharedDrivesUnavailableError, type DriveFile } from "./drive";

/** fetch mock that records the Drive query (`q`) of every call and answers with `files`. */
function mockFetch(files: DriveFile[] = []) {
  const queries: string[] = [];
  const params: URLSearchParams[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    params.push(url.searchParams);
    queries.push(url.searchParams.get("q") ?? "");
    return new Response(JSON.stringify({ files }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, queries, params };
}

describe("FILE_FIELDS", () => {
  it("requests owners, capabilities, shared and driveId", () => {
    for (const f of ["owners(emailAddress,me)", "ownedByMe", "capabilities(canEdit,canAddChildren,canShare,canDownload)", "copyRequiresWriterPermission", "shared", "driveId", "md5Checksum"]) {
      expect(FILE_FIELDS).toContain(f);
    }
  });
});

describe("DriveClient.search", () => {
  it("does not filter by mimeType unless asked, so folders are included", async () => {
    const m = mockFetch();
    await new DriveClient("tok", m.fetchImpl).search({ query: "Northwind" });
    expect(m.queries[0]).not.toContain("mimeType");
    expect(m.queries[0]).not.toContain("owners");
  });
  it("restricts to folders with foldersOnly", async () => {
    const m = mockFetch();
    await new DriveClient("tok", m.fetchImpl).search({ query: "Northwind", foldersOnly: true });
    expect(m.queries[0]).toContain(`mimeType = '${FOLDER_MIME}'`);
  });
  it("restricts to own files when includeShared is false", async () => {
    const m = mockFetch();
    await new DriveClient("tok", m.fetchImpl).search({ query: "x", includeShared: false });
    expect(m.queries[0]).toContain("'me' in owners");
  });
});

describe("DriveClient.listSharedWithMe", () => {
  it("queries sharedWithMe newest first, optionally folders only and by name", async () => {
    const m = mockFetch();
    const d = new DriveClient("tok", m.fetchImpl);
    await d.listSharedWithMe({});
    expect(m.queries[0]).toContain("sharedWithMe = true");
    expect(m.queries[0]).toContain("trashed = false");
    expect(m.queries[0]).not.toContain("mimeType");
    expect(m.params[0]?.get("orderBy")).toMatch(/desc/);

    await d.listSharedWithMe({ foldersOnly: true, query: "Mega's", pageToken: "p2" });
    expect(m.queries[1]).toContain(`mimeType = '${FOLDER_MIME}'`);
    expect(m.queries[1]).toContain(String.raw`name contains 'Mega\'s'`);
    expect(m.params[1]?.get("pageToken")).toBe("p2");
  });
});

describe("DriveClient.findSharedFolderByName", () => {
  it("matches a shared-with-me folder by exact name, case-insensitively", async () => {
    const m = mockFetch([
      { id: "other", name: "Northwind Phase I - All Details (old)", mimeType: FOLDER_MIME },
      { id: "top", name: "Northwind Phase I - All Details", mimeType: FOLDER_MIME },
    ]);
    const d = new DriveClient("tok", m.fetchImpl);
    const hit = await d.findSharedFolderByName("northwind phase i - all details");
    expect(hit?.id).toBe("top");
    expect(m.queries[0]).toContain("sharedWithMe = true");
    expect(m.queries[0]).toContain(`mimeType = '${FOLDER_MIME}'`);
    expect(await d.findSharedFolderByName("Nope")).toBeUndefined();
  });
});

describe("Shared Drive support", () => {
  it("sends supportsAllDrives on every files.* call and includeItemsFromAllDrives/corpora when listing", async () => {
    const m = mockFetch([{ id: "x", name: "x", mimeType: "text/plain" }]);
    const d = new DriveClient("tok", m.fetchImpl);
    await d.getFile("f1");
    await d.listChildren("p1");
    await d.search({ query: "q" });
    await d.listSharedWithMe({});
    await d.findChildByName("p1", "x", false);
    await d.createFolder("New", "p1");
    await d.patch("f1", { name: "y" });
    await d.setTrashed("f1", true);
    await d.copy("f1", { name: "copy", parents: ["p2"] });
    for (const p of m.params) expect(p.get("supportsAllDrives")).toBe("true");
    // listing/searching calls (listChildren, search, listSharedWithMe, findChildByName)
    for (const i of [1, 2, 3, 4]) {
      expect(m.params[i]?.get("includeItemsFromAllDrives")).toBe("true");
      expect(m.params[i]?.get("corpora")).toBe("allDrives");
    }
    expect(m.params[0]?.get("includeItemsFromAllDrives")).toBeNull();
  });

  it("lists Shared Drives and finds one by name case-insensitively", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.pathname + "?" + url.searchParams.toString());
      return new Response(JSON.stringify({ drives: [{ id: "d1", name: "Finance" }, { id: "d2", name: "Projects" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const d = new DriveClient("tok", fetchImpl);
    expect(await d.listDrives()).toEqual([
      { id: "d1", name: "Finance" },
      { id: "d2", name: "Projects" },
    ]);
    expect(calls[0]).toContain("/drive/v3/drives?");
    expect(await d.findDriveByName("projects")).toEqual({ id: "d2", name: "Projects" });
    expect(await d.findDriveByName("Nope")).toBeUndefined();
  });

  it("reports Shared Drives as not reachable (instead of an empty list) when drives.list answers 403/404", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: "insufficient permissions" } }), { status: 403 })) as unknown as typeof fetch;
    const d = new DriveClient("tok", fetchImpl);
    await expect(d.listDrives()).rejects.toBeInstanceOf(SharedDrivesUnavailableError);
    await expect(d.findDriveByName("Finance")).rejects.toThrow(/Shared Drive "Finance" is not reachable/);
  });
});

describe("DriveClient permissions and copy", () => {
  function recorder(body: unknown = {}, status = 200) {
    const reqs: { method: string; path: string; params: URLSearchParams; body: unknown }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      reqs.push({ method: init?.method ?? "GET", path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    });
    return { fetchImpl: fetchImpl as unknown as typeof fetch, reqs };
  }

  it("copy posts to files/{id}/copy with name and parents", async () => {
    const r = recorder({ id: "c1", name: "copy" });
    await new DriveClient("tok", r.fetchImpl).copy("f1", { name: "copy", parents: ["p2"] });
    expect(r.reqs[0]).toMatchObject({ method: "POST", path: "/drive/v3/files/f1/copy", body: { name: "copy", parents: ["p2"] } });
  });

  it("listPermissions requests email, role, type, displayName and pendingOwner", async () => {
    const r = recorder({ permissions: [{ id: "p", type: "user", role: "writer", emailAddress: "a@b.c", displayName: "A" }] });
    const perms = await new DriveClient("tok", r.fetchImpl).listPermissions("f1");
    expect(perms[0]).toMatchObject({ emailAddress: "a@b.c", role: "writer" });
    expect(r.reqs[0]?.path).toBe("/drive/v3/files/f1/permissions");
    for (const f of ["emailAddress", "role", "type", "displayName", "pendingOwner"]) expect(r.reqs[0]?.params.get("fields")).toContain(f);
    expect(r.reqs[0]?.params.get("supportsAllDrives")).toBe("true");
  });

  it("createPermission sends role/email in the body and notification/transfer flags as query params", async () => {
    const r = recorder({ id: "p1", role: "writer" });
    const d = new DriveClient("tok", r.fetchImpl);
    await d.createPermission("f1", { type: "user", role: "writer", emailAddress: "a@b.c" }, { sendNotificationEmail: false });
    expect(r.reqs[0]).toMatchObject({ method: "POST", path: "/drive/v3/files/f1/permissions", body: { type: "user", role: "writer", emailAddress: "a@b.c" } });
    expect(r.reqs[0]?.params.get("sendNotificationEmail")).toBe("false");
    expect(r.reqs[0]?.params.has("transferOwnership")).toBe(false);
    await d.createPermission("f1", { type: "user", role: "owner", emailAddress: "a@b.c" }, { sendNotificationEmail: true, transferOwnership: true, emailMessage: "hi" });
    expect(r.reqs[1]?.params.get("transferOwnership")).toBe("true");
    expect(r.reqs[1]?.params.get("emailMessage")).toBe("hi");
  });

  it("updatePermission patches and removePermission deletes one permission (never the file)", async () => {
    const r = recorder({ id: "p1", role: "writer", pendingOwner: true });
    const d = new DriveClient("tok", r.fetchImpl);
    await d.updatePermission("f1", "p1", { role: "writer", pendingOwner: true });
    expect(r.reqs[0]).toMatchObject({ method: "PATCH", path: "/drive/v3/files/f1/permissions/p1", body: { role: "writer", pendingOwner: true } });
    const del = recorder(undefined, 204);
    await new DriveClient("tok", del.fetchImpl).removePermission("f1", "p1");
    expect(del.reqs[0]).toMatchObject({ method: "DELETE", path: "/drive/v3/files/f1/permissions/p1" });
    expect(typeof (d as unknown as Record<string, unknown>).delete).toBe("undefined");
  });

  it("createShortcut posts a shortcut file pointing at the target", async () => {
    const r = recorder({ id: "s1", name: "Link", mimeType: "application/vnd.google-apps.shortcut" });
    await new DriveClient("tok", r.fetchImpl).createShortcut("Link", "target1", "p1");
    expect(r.reqs[0]).toMatchObject({
      method: "POST",
      path: "/drive/v3/files",
      body: { name: "Link", mimeType: "application/vnd.google-apps.shortcut", parents: ["p1"], shortcutDetails: { targetId: "target1" } },
    });
  });

  it("listFiles passes q, orderBy, pageSize and pageToken through", async () => {
    const r = recorder({ files: [], nextPageToken: "n" });
    const page = await new DriveClient("tok", r.fetchImpl).listFiles({ q: "trashed = false", orderBy: "modifiedTime desc", pageSize: 1000, pageToken: "t" });
    expect(page.nextPageToken).toBe("n");
    expect(r.reqs[0]?.params.get("q")).toBe("trashed = false");
    expect(r.reqs[0]?.params.get("orderBy")).toBe("modifiedTime desc");
    expect(r.reqs[0]?.params.get("pageSize")).toBe("1000");
    expect(r.reqs[0]?.params.get("pageToken")).toBe("t");
    expect(r.reqs[0]?.params.get("corpora")).toBe("allDrives");
  });
});
