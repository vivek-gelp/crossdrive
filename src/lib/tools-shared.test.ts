import { describe, expect, it } from "vitest";
import { assertWritable, fileResult } from "./tools";
import { FOLDER_MIME, type DriveFile } from "./drive";

const ME = "alex@acme.example";

describe("fileResult", () => {
  it("marks own files as owner=me, shared=false, canEdit from capabilities", () => {
    const f: DriveFile = {
      id: "a",
      name: "2026-01-01_Acme_Note.md",
      mimeType: "text/plain",
      owners: [{ emailAddress: "Alex@Acme.example" }],
      capabilities: { canEdit: true, canAddChildren: false },
    };
    const r = fileResult("work", ME, f, "work:/01_Company/2026-01-01_Acme_Note.md");
    expect(r).toMatchObject({ owner: "me", shared: false, canEdit: true, path: "work:/01_Company/2026-01-01_Acme_Note.md" });
  });
  it("marks files owned by someone else as shared with the owner's email", () => {
    const f: DriveFile = {
      id: "b",
      name: "Northwind Phase I - All Details",
      mimeType: FOLDER_MIME,
      owners: [{ emailAddress: "team@acme.example" }],
      capabilities: { canEdit: false, canAddChildren: false },
      shared: true,
    };
    const r = fileResult("work", ME, f, "work:~shared/Northwind Phase I - All Details");
    expect(r).toMatchObject({ owner: "team@acme.example", shared: true, canEdit: false });
  });
  it("treats missing owners as me and missing capabilities as editable", () => {
    const r = fileResult("work", ME, { id: "c", name: "x", mimeType: "text/plain" }, "work:/x");
    expect(r).toMatchObject({ owner: "me", shared: false, canEdit: true });
  });
});

describe("assertWritable", () => {
  const viewOnly: DriveFile = {
    id: "v",
    name: "Proposals",
    mimeType: FOLDER_MIME,
    owners: [{ emailAddress: "team@acme.example" }],
    capabilities: { canEdit: false, canAddChildren: false },
  };
  it("returns a clear view-only error instead of a raw 403", () => {
    expect(() => assertWritable(viewOnly, "edit")).toThrow(
      "view-only: you cannot modify Proposals (owner team@acme.example). Ask the owner to grant Editor or transfer ownership.",
    );
    expect(() => assertWritable(viewOnly, "addChildren")).toThrow(/view-only: you cannot modify Proposals/);
  });
  it("passes editable items and items with unknown capabilities", () => {
    expect(() => assertWritable({ ...viewOnly, capabilities: { canEdit: true, canAddChildren: true } }, "edit")).not.toThrow();
    expect(() => assertWritable({ ...viewOnly, capabilities: { canEdit: true, canAddChildren: true } }, "addChildren")).not.toThrow();
    expect(() => assertWritable({ id: "x", name: "x", mimeType: "text/plain" }, "edit")).not.toThrow();
  });
  it("blocks adding children to a folder you can only edit metadata of", () => {
    expect(() => assertWritable({ ...viewOnly, capabilities: { canEdit: true, canAddChildren: false } }, "addChildren")).toThrow(/view-only/);
  });
});
