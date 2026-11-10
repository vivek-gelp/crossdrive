import { describe, expect, it, vi } from "vitest";
import { resolvePutTarget, inboxFolder } from "./tools";
import type { DriveClient, DriveFile } from "./drive";

const folder = (id: string, name: string): DriveFile => ({
  id,
  name,
  mimeType: "application/vnd.google-apps.folder",
});

describe("resolvePutTarget", () => {
  it("defaults to the inbox folder (VAULT_INBOX_FOLDER, default Inbox), creating it when missing", async () => {
    const drive = {
      listChildren: vi.fn(async () => ({ files: [] })),
      createFolder: vi.fn(async (name: string) => folder("inbox1", name)),
    } as unknown as DriveClient;
    const target = await resolvePutTarget(drive, {});
    expect(target).toBe("inbox1");
    expect(drive.createFolder).toHaveBeenCalledWith("Inbox", "root");
  });
  it("reuses existing inbox folder", async () => {
    const drive = {
      listChildren: vi.fn(async () => ({ files: [folder("inboxX", inboxFolder())] })),
      createFolder: vi.fn(),
    } as unknown as DriveClient;
    expect(await resolvePutTarget(drive, {})).toBe("inboxX");
    expect(drive.createFolder).not.toHaveBeenCalled();
  });
  it("prefers folderId, then path", async () => {
    const drive = {
      listChildren: vi.fn(async () => ({ files: [folder("a1", "A")] })),
      createFolder: vi.fn(),
    } as unknown as DriveClient;
    expect(await resolvePutTarget(drive, { folderId: "explicit" })).toBe("explicit");
    expect(await resolvePutTarget(drive, { path: "/A" })).toBe("a1");
  });
});
