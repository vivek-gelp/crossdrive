import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { fileResult } from "./ctx";
import { FILE_FIELDS, FOLDER_MIME } from "./drive";
import { registerAllTools, setDriveFetch } from "./tools";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";

/** Defect 8 (round 2): Drive can omit `ownedByMe` (and `owners`) on items shared with the account. */

const ME = "alex.example@gmail.com";

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const { storeMock } = await import("./testing/fakeDrive");
  return { ...orig, ...storeMock([{ label: "personal", email: "alex.example@gmail.com" }]) };
});

type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;

describe("ownership without ownedByMe", () => {
  it("an item with neither ownedByMe nor owners is unknown and shared, not me", () => {
    expect(fileResult("personal", ME, { id: "x", name: "x.pdf", mimeType: "application/pdf" }, "personal:~shared/x.pdf")).toMatchObject({ owner: "unknown", shared: true });
  });
  it("owners[].me or the account's email still mark the item as mine", () => {
    expect(fileResult("personal", ME, { id: "a", name: "a", mimeType: "x", owners: [{ me: true }] }, "personal:/a")).toMatchObject({ owner: "me", shared: false });
    expect(fileResult("personal", ME, { id: "a", name: "a", mimeType: "x", owners: [{ emailAddress: "Alex.Example@gmail.com" }] }, "personal:/a")).toMatchObject({ owner: "me", shared: false });
  });
  it("ownedByMe=false wins over a matching owner email", () => {
    expect(fileResult("personal", ME, { id: "a", name: "a", mimeType: "x", ownedByMe: false, owners: [{ emailAddress: ME }] }, "")).toMatchObject({ shared: true });
  });
  it("a Shared Drive item outside a drive/ path (account is not a member) is owned by the drive and shared", () => {
    expect(fileResult("personal", ME, { id: "t", name: "t", mimeType: "x", driveId: "d9" }, "personal:~shared/t")).toMatchObject({ owner: "shared drive", shared: true });
  });
  it("a sharedWithMe item is never shared:false, even if it looks like mine", () => {
    expect(fileResult("personal", ME, { id: "o", name: "o", mimeType: "x", ownedByMe: true }, "", { sharedWithMe: true })).toMatchObject({ shared: true });
  });
  it("FILE_FIELDS asks Drive for ownedByMe and owners(emailAddress,me)", () => {
    expect(FILE_FIELDS).toContain("ownedByMe");
    expect(FILE_FIELDS).toContain("owners(emailAddress,me)");
  });
});

describe("shared tool", () => {
  let tools: Record<string, Handler>;
  beforeEach(() => {
    setStore(memoryStore());
    tools = {};
    registerAllTools({ registerTool: (name: string, _def: unknown, h: Handler) => void (tools[name] = h) } as unknown as McpServer);
  });
  afterEach(() => {
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("reports hidden-owner and Shared Drive items as shared, never owner me / shared false", async () => {
    const files: Record<string, FakeFile> = {
      proot: { id: "proot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: ME }] },
      hidden: { id: "hidden", name: "Link only.pdf", mimeType: "application/pdf", sharedWithMe: true, perms: { [ME]: "reader" }, capabilities: { canEdit: false } },
      team: { id: "team", name: "Team sheet", mimeType: "application/vnd.google-apps.spreadsheet", driveId: "d9", sharedWithMe: true, perms: { [ME]: "reader" } },
      sam: { id: "sam", name: "Sam's folder", mimeType: FOLDER_MIME, owners: [{ emailAddress: "sam@example.org" }], sharedWithMe: true, perms: { [ME]: "writer" } },
    };
    setDriveFetch(fakeDrive([{ label: "personal", email: ME }], files).fetchImpl);
    const r = await tools.shared!({ account: "personal" }, {} as ServerContext);
    expect(r.isError, r.content[0]?.text).toBeFalsy();
    const out = (JSON.parse(r.content[0]!.text) as { files: { id: string; owner: string; shared: boolean }[] }).files;
    expect(out).toHaveLength(3);
    for (const f of out) {
      expect(f.shared, f.id).toBe(true);
      expect(f.owner, f.id).not.toBe("me");
    }
    expect(Object.fromEntries(out.map((f) => [f.id, f.owner]))).toEqual({ hidden: "unknown", team: "shared drive", sam: "sam@example.org" });
  });
});
