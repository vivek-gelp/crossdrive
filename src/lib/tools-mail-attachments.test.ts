import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { readAudit } from "./audit";
import { FOLDER_MIME } from "./drive";
import { setMailFetch } from "./mail";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";
import { fakeGmail, type FakeMessageSpec } from "./testing/fakeGmail";
import { registerAllTools, registerReadTools, setDriveFetch } from "./tools";


// These tests exercise the optional naming rule (VAULT_NAMING_RULE=date-entity).
process.env.VAULT_NAMING_RULE = "date-entity";
const WORK = "alex@acme.example";
const PERSONAL = "alex.example@gmail.com";
const GMAIL = ["drive", "gmail.compose", "gmail.modify", "gmail.send"];
const SPECS = [
  { label: "work", email: WORK, scopes: GMAIL },
  { label: "personal", email: PERSONAL },
];

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const { storeMock } = await import("./testing/fakeDrive");
  return {
    ...orig,
    ...storeMock([
      { label: "work", email: "alex@acme.example", scopes: ["drive", "gmail.compose", "gmail.modify", "gmail.send"] },
      { label: "personal", email: "alex.example@gmail.com" },
    ]),
  };
});

type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type Def = { inputSchema: { parse(v: unknown): unknown; shape: Record<string, unknown> }; annotations?: Record<string, boolean> };

function collect(register: (s: McpServer) => void) {
  const tools: Record<string, Handler> = {};
  const defs: Record<string, Def> = {};
  const server = {
    registerTool: (name: string, d: Def, h: Handler) => {
      tools[name] = h;
      defs[name] = d;
    },
  } as unknown as McpServer;
  register(server);
  return { tools, defs };
}

async function call(tools: Record<string, Handler>, name: string, args: Record<string, unknown>) {
  const r = await tools[name]!(args, {} as ServerContext);
  const textOut = r.content[0]?.text ?? "";
  return { isError: r.isError === true, text: textOut, json: r.isError ? undefined : (JSON.parse(textOut) as Record<string, unknown>) };
}

const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const BIG = "x".repeat(5 * 1024 * 1024 + 1);
function messages(): FakeMessageSpec[] {
  return [
    {
      id: "a1",
      threadId: "ta",
      date: T0,
      from: "Sam <sam@northwind.example>",
      to: [WORK],
      subject: "Survey report",
      text: "Please find the survey attached.",
      attachments: [
        { filename: "Survey.csv", mimeType: "text/csv", size: 11, content: "a,b\n1,2\n3,4" },
        { filename: "photo.jpg", mimeType: "image/jpeg", size: 3, content: "JPG" },
      ],
    },
    { id: "a2", threadId: "ta", date: T0 + 1000, from: "Sam <sam@northwind.example>", to: [WORK], subject: "Re: Survey report", text: "And the raw data.", attachments: [{ filename: "raw data.txt", mimeType: "text/plain", size: 4, content: "1234" }] },
    { id: "b1", threadId: "tb", date: T0, from: "big@example.com", to: [WORK], subject: "Big one", text: "x", attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", size: BIG.length, content: BIG }] },
    {
      id: "p1",
      threadId: "tp",
      date: T0,
      from: "legal@example.com",
      to: [WORK],
      subject: "PPA",
      text: "see attached",
      attachments: [
        { filename: "Example_PPA.pdf", mimeType: "application/pdf", size: SAMPLE.length, content: SAMPLE },
        { filename: "scan.pdf", mimeType: "application/pdf", size: SCANNED.length, content: SCANNED },
      ],
    },
  ];
}

const SCANNED = readFileSync(new URL("./testing/fixtures/scanned.pdf", import.meta.url)).toString("latin1");
const SAMPLE = readFileSync(new URL("./testing/fixtures/sample.pdf", import.meta.url)).toString("latin1");

function driveFiles(): Record<string, FakeFile> {
  return {
    root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: WORK }] },
    co: { id: "co", name: "01_Company", mimeType: FOLDER_MIME, parents: ["root"], owners: [{ emailAddress: WORK }] },
    proot: { id: "proot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: PERSONAL }] },
    ideas: { id: "ideas", name: "10_Ideas", mimeType: FOLDER_MIME, parents: ["proot"], owners: [{ emailAddress: PERSONAL }] },
  };
}

describe("mail attachments", () => {
  let tools: Record<string, Handler>;
  let defs: Record<string, Def>;
  let gmail: ReturnType<typeof fakeGmail>;
  let drive: ReturnType<typeof fakeDrive>;

  beforeEach(() => {
    setStore(memoryStore());
    ({ tools, defs } = collect(registerAllTools));
    gmail = fakeGmail([{ label: "work", email: WORK, messages: messages() }]);
    setMailFetch(gmail.fetchImpl);
    drive = fakeDrive(SPECS, driveFiles());
    setDriveFetch(drive.fetchImpl);
  });
  afterEach(() => {
    setMailFetch(undefined);
    setDriveFetch(undefined);
    setStore(undefined);
  });

  it("returns the text of a csv attachment through the readers, paginated", async () => {
    const r = await call(tools, "mail_attachment", { account: "work", messageId: "a1", partId: "2", maxChars: 20000, offset: 0 });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ account: "work", messageId: "a1", partId: "2", index: 0, filename: "Survey.csv", mimeType: "text/csv", size: 11, text: "a,b\n1,2\n3,4", truncated: false, totalChars: 11 });
    const cut = await call(tools, "mail_attachment", { account: "work", messageId: "a1", filename: "Survey.csv", maxChars: 100, offset: 4 });
    expect(cut.json).toMatchObject({ text: "1,2\n3,4", offset: 4, truncated: false });
    expect(gmail.log.some((l) => l.path.endsWith("/messages/a1/attachments/att-a1-0"))).toBe(true);
    expect(await readAudit()).toEqual([]);
  });

  it("extracts PDF text and explains a scanned PDF", async () => {
    const pdf = await call(tools, "mail_attachment", { account: "work", messageId: "p1", index: 0, maxChars: 1000, offset: 0 });
    expect(pdf.isError, pdf.text).toBe(false);
    expect(pdf.json).toMatchObject({ filename: "Example_PPA.pdf", text: "Example PPA page one\n\nSecond page of the agreement", truncated: false });
    const scan = await call(tools, "mail_attachment", { account: "work", messageId: "p1", index: 1, maxChars: 1000, offset: 0 });
    expect(scan.isError, scan.text).toBe(false);
    expect(scan.json).toMatchObject({ filename: "scan.pdf", text: null, note: expect.stringMatching(/^No extractable text: this PDF has no text layer.*Use saveTo/) });
  });

  it("gives metadata only for images and names the missing attachment otherwise", async () => {
    const img = await call(tools, "mail_attachment", { account: "work", messageId: "a1", index: 1, maxChars: 1000, offset: 0 });
    expect(img.isError, img.text).toBe(false);
    expect(img.json).toMatchObject({ filename: "photo.jpg", mimeType: "image/jpeg", size: 3, text: null, note: expect.stringMatching(/No text reader for image\/jpeg/) });
    const missing = await call(tools, "mail_attachment", { account: "work", messageId: "a1", attachmentId: "nope", maxChars: 1000, offset: 0 });
    expect(missing.isError).toBe(true);
    expect(missing.text).toMatch(/no attachment nope\. Attachments: #0 Survey\.csv \(partId 2\), #1 photo\.jpg \(partId 3\)\. Select by partId, index or filename/);
    expect((await call(tools, "mail_attachment", { account: "work", messageId: "a1", index: 5, maxChars: 1000, offset: 0 })).text).toMatch(/no attachment #5/);
    expect((await call(tools, "mail_attachment", { account: "work", messageId: "a1", maxChars: 1000, offset: 0 })).text).toMatch(/Give partId, index or filename/);
  });

  it("survives Gmail handing out new attachment ids on every read (stale ids, partId/index/filename selectors)", async () => {
    const volatile = fakeGmail([{ label: "work", email: WORK, messages: messages() }], { volatileAttachmentIds: true });
    setMailFetch(volatile.fetchImpl);
    const read = await call(tools, "mail_read", { account: "work", messageId: "a1", maxChars: 1000 });
    const att = (read.json!.messages as { attachments: { attachmentId: string; partId: string; index: number; filename: string }[] }[])[0]!.attachments;
    expect(att.map((x) => [x.partId, x.index, x.filename])).toEqual([
      ["2", 0, "Survey.csv"],
      ["3", 1, "photo.jpg"],
    ]);
    const stale = att[0]!.attachmentId;
    expect(stale).toMatch(/^att-a1-0-v\d+$/);
    // Every selector re-fetches the message and uses the fresh id.
    for (const sel of [{ partId: "2" }, { index: 0 }, { filename: "Survey.csv" }]) {
      const r = await call(tools, "mail_attachment", { account: "work", messageId: "a1", ...sel, maxChars: 1000, offset: 0 });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toMatchObject({ filename: "Survey.csv", text: "a,b\n1,2\n3,4" });
    }
    // A stale id for a message with several attachments is refused with the stable selectors listed ...
    const byStale = await call(tools, "mail_attachment", { account: "work", messageId: "a1", attachmentId: stale, maxChars: 1000, offset: 0 });
    expect(byStale.isError).toBe(true);
    expect(byStale.text).toMatch(/attachmentId is not stable/);
    // ... while a message with exactly one attachment still resolves.
    const single = await call(tools, "mail_read", { account: "work", messageId: "a2", maxChars: 1000 });
    const staleSingle = (single.json!.messages as { attachments: { attachmentId: string }[] }[])[0]!.attachments[0]!.attachmentId;
    const one = await call(tools, "mail_attachment", { account: "work", messageId: "a2", attachmentId: staleSingle, maxChars: 1000, offset: 0 });
    expect(one.isError, one.text).toBe(false);
    expect(one.json).toMatchObject({ filename: "raw data.txt", text: "1234" });
    // The downloads used ids from their own fetch, never the stale one.
    const gets = volatile.log.filter((l) => l.path.includes("/attachments/")).map((l) => l.path.split("/attachments/")[1]);
    expect(gets).not.toContain(stale);
    // saveAttachmentsTo also works with volatile ids.
    const saved = await call(tools, "mail_read", { account: "work", threadId: "ta", maxChars: 1000, saveAttachmentsTo: { account: "work", folderId: "co", allowNonStandardName: true } });
    expect(saved.isError, saved.text).toBe(false);
    expect((saved.json!.saved as { status: string }[]).map((s) => s.status)).toEqual(["saved", "saved", "saved"]);
  });

  it("saveTo stores the attachment in a Drive folder of another account, audit-logged, naming rule enforced", async () => {
    const bad = await call(tools, "mail_attachment", { account: "work", messageId: "a1", attachmentId: "att-a1-0", maxChars: 1000, offset: 0, saveTo: { account: "personal", folderId: "ideas", allowNonStandardName: false } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/naming rule/);
    expect(drive.log.filter((l) => l.path.startsWith("/upload"))).toHaveLength(0);

    const r = await call(tools, "mail_attachment", {
      account: "work",
      messageId: "a1",
      index: 0,
      maxChars: 1000,
      offset: 0,
      saveTo: { account: "personal", path: "personal:/10_Ideas", name: "2026-11-01_Northwind_Survey.csv", allowNonStandardName: false },
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ filename: "Survey.csv", size: 11, saved: { account: "personal", name: "2026-11-01_Northwind_Survey.csv", path: "personal:/10_Ideas/2026-11-01_Northwind_Survey.csv", mimeType: "text/csv", size: 11, owner: "me" } });
    expect(r.json!.text).toBeUndefined();
    const up = drive.log.find((l) => l.path === "/upload/drive/v3/files")!;
    expect(up.account).toBe("personal");
    expect(up.params.get("uploadType")).toBe("multipart");
    const saved = Object.values(drive.files).find((f) => f.name === "2026-11-01_Northwind_Survey.csv")!;
    expect(saved).toMatchObject({ parents: ["ideas"], content: "a,b\n1,2\n3,4" });
    expect((await readAudit(5))[0]).toMatchObject({ tool: "mail_attachment", account: "work", toAccount: "personal", fileId: saved.id, name: saved.name, to: "ideas", messageId: "a1", attachments: ["Survey.csv"], size: 11 });
  });

  it("uses a resumable session above 5 MB", async () => {
    const r = await call(tools, "mail_attachment", { account: "work", messageId: "b1", attachmentId: "att-b1-0", maxChars: 1000, offset: 0, saveTo: { account: "work", folderId: "co", allowNonStandardName: true } });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ saved: { name: "big.bin", size: BIG.length, path: "work:/01_Company/big.bin" } });
    const session = Object.values(drive.sessions)[0]!;
    expect(session).toMatchObject({ account: "work", meta: { name: "big.bin", parents: ["co"] }, contentType: "application/octet-stream", declaredSize: BIG.length, receivedBytes: BIG.length });
    expect(session.ranges).toEqual([`bytes 0-${BIG.length - 1}/${BIG.length}`]);
  });

  it("mail_read saveAttachmentsTo saves every attachment of a thread with a prefix and lists the files", async () => {
    const r = await call(tools, "mail_read", { account: "work", threadId: "ta", maxChars: 1000, saveAttachmentsTo: { account: "work", path: "work:/01_Company", prefix: "2026-11-01_Northwind", allowNonStandardName: false } });
    expect(r.isError, r.text).toBe(false);
    const saved = r.json!.saved as { messageId: string; filename: string; status: string; file?: { name: string; path: string }; error?: string }[];
    expect(saved.map((s) => [s.messageId, s.filename, s.status])).toEqual([
      ["a1", "Survey.csv", "saved"],
      ["a1", "photo.jpg", "saved"],
      ["a2", "raw data.txt", "saved"],
    ]);
    expect(saved[0]!.file).toMatchObject({ name: "2026-11-01_Northwind_Survey.csv", path: "work:/01_Company/2026-11-01_Northwind_Survey.csv" });
    expect(saved[2]!.file).toMatchObject({ name: "2026-11-01_Northwind_raw data.txt" });
    expect((r.json!.messages as unknown[]).length).toBe(2);
    expect((await readAudit(10)).filter((e) => e.tool === "mail_attachment")).toHaveLength(3);
  });

  it("reports per-attachment errors without aborting and without a prefix applies the naming rule", async () => {
    const r = await call(tools, "mail_read", { account: "work", messageId: "a1", maxChars: 1000, saveAttachmentsTo: { account: "work", folderId: "co", allowNonStandardName: false } });
    expect(r.isError, r.text).toBe(false);
    const saved = r.json!.saved as { status: string; error?: string }[];
    expect(saved.map((s) => s.status)).toEqual(["error", "error"]);
    expect(saved[0]!.error).toMatch(/naming rule/);
  });

  it("read-only tokens get mail_attachment (text only) and mail_read without saving", async () => {
    const ro = collect(registerReadTools);
    expect(ro.defs.mail_attachment!.annotations).toEqual({ readOnlyHint: true });
    expect(ro.defs.mail_read!.annotations).toEqual({ readOnlyHint: true });
    expect(Object.keys(ro.defs.mail_attachment!.inputSchema.shape)).not.toContain("saveTo");
    expect(Object.keys(ro.defs.mail_read!.inputSchema.shape)).not.toContain("saveAttachmentsTo");
    expect(Object.keys(defs.mail_attachment!.inputSchema.shape)).toContain("saveTo");
    expect(Object.keys(defs.mail_read!.inputSchema.shape)).toContain("saveAttachmentsTo");
    // Even if a saveTo slips through, the read-only handler never writes.
    const r = await call(ro.tools, "mail_attachment", { account: "work", messageId: "a1", attachmentId: "att-a1-0", maxChars: 1000, offset: 0, saveTo: { account: "work", folderId: "co" } });
    expect(r.isError, r.text).toBe(false);
    expect(r.json!.text).toBe("a,b\n1,2\n3,4");
    expect(drive.log.filter((l) => l.method !== "GET")).toHaveLength(0);
  });
});
