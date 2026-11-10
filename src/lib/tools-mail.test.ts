import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { readAudit } from "./audit";
import { FOLDER_MIME } from "./drive";
import { setMailFetch } from "./mail";
import { setStore } from "./store";
import { fakeDrive, memoryStore, type FakeFile } from "./testing/fakeDrive";
import { fakeGmail, type FakeMessageSpec } from "./testing/fakeGmail";
import { registerAllTools, registerReadTools, setDriveFetch } from "./tools";

const WORK = "alex@acme.example";
const PERSONAL = "alex.example@gmail.com";
const GMAIL = ["drive", "gmail.compose", "gmail.modify", "gmail.send"];
const SPECS = [
  { label: "work", email: WORK, scopes: GMAIL },
  { label: "personal", email: PERSONAL }, // Drive only: Gmail not granted
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
type Def = { inputSchema: { parse(v: unknown): unknown }; annotations?: Record<string, boolean> };

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
function messages(): FakeMessageSpec[] {
  return [
    { id: "a1", threadId: "ta", date: T0, from: "Sam <sam@northwind.example>", to: [WORK], cc: ["team@acme.example"], subject: "Survey report", text: "Please find the survey attached.", attachments: [{ filename: "Survey.pdf", mimeType: "application/pdf", size: 5000 }], labelIds: ["INBOX", "UNREAD"] },
    { id: "a2", threadId: "ta", date: T0 + 3_600_000, from: `Alex <${WORK}>`, to: ["Sam <sam@northwind.example>"], cc: ["team@acme.example"], subject: "Re: Survey report", text: "Thanks, reviewing.", labelIds: ["SENT"] },
    { id: "b1", threadId: "tb", date: T0 - 86_400_000, from: "Lender <loans@lender.example>", to: [WORK], subject: "Utilisation certificate Q2", html: "<p>Dear Sir,<br>please <b>submit</b> by Friday.</p>", labelIds: ["INBOX"] },
    { id: "c1", threadId: "tc", date: T0 + 7_200_000, from: "newsletter@example.com", to: [WORK], subject: "Weekly digest", text: "News", labelIds: ["INBOX", "UNREAD", "Label_1"] },
  ];
}

function driveFiles(): Record<string, FakeFile> {
  return {
    root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: WORK }] },
    rep: { id: "rep", name: "2026-01-05_Acme_Report.pdf", mimeType: "application/pdf", parents: ["root"], owners: [{ emailAddress: WORK }], size: "10", content: "%PDF-1.4 ..." },
    gdoc: { id: "gdoc", name: "Board notes", mimeType: "application/vnd.google-apps.document", parents: ["root"], owners: [{ emailAddress: WORK }] },
    folder: { id: "folder", name: "01_Company", mimeType: FOLDER_MIME, parents: ["root"], owners: [{ emailAddress: WORK }] },
    big: { id: "big", name: "big.bin", mimeType: "application/octet-stream", parents: ["root"], owners: [{ emailAddress: WORK }], size: String(21 * 1024 * 1024), content: "x" },
    proot: { id: "proot", name: "My Drive", mimeType: FOLDER_MIME, owners: [{ emailAddress: PERSONAL }] },
    pnote: { id: "pnote", name: "2026-02-01_Personal_Note.txt", mimeType: "text/plain", parents: ["proot"], owners: [{ emailAddress: PERSONAL }], size: "5", content: "hello" },
  };
}

describe("mail tools", () => {
  let tools: Record<string, Handler>;
  let defs: Record<string, Def>;
  let gmail: ReturnType<typeof fakeGmail>;

  beforeEach(() => {
    setStore(memoryStore());
    ({ tools, defs } = collect(registerAllTools));
    gmail = fakeGmail([
      { label: "work", email: WORK, messages: messages() },
      { label: "personal", email: PERSONAL, messages: [] },
    ]);
    setMailFetch(gmail.fetchImpl);
    setDriveFetch(fakeDrive(SPECS, driveFiles()).fetchImpl);
  });
  afterEach(() => {
    setMailFetch(undefined);
    setDriveFetch(undefined);
    setStore(undefined);
  });

  describe("registration", () => {
    it("registers the eight mail tools with honest annotations", () => {
      for (const t of ["mail_search", "mail_labels"]) expect(defs[t]!.annotations).toEqual({ readOnlyHint: true });
      // On the full server mail_read and mail_attachment can save attachments to Drive, so they are not read-only there.
      for (const t of ["mail_read", "mail_attachment", "mail_draft", "mail_send", "mail_reply", "mail_label"]) expect(defs[t]!.annotations?.readOnlyHint).toBeUndefined();
    });
    it("gives a read-only token mail_search, mail_read, mail_attachment and mail_labels, all read-only", () => {
      const ro = collect(registerReadTools);
      expect(Object.keys(ro.tools).filter((n) => n.startsWith("mail_")).sort()).toEqual(["mail_attachment", "mail_labels", "mail_read", "mail_search"]);
      for (const t of ["mail_search", "mail_read", "mail_attachment", "mail_labels"]) expect(ro.defs[t]!.annotations).toEqual({ readOnlyHint: true });
    });
    it("validates arguments: account required, addresses well-formed, limit capped", () => {
      const s = defs.mail_send!.inputSchema;
      expect(() => s.parse({ to: ["a@b.com"], subject: "x", body: "y" })).toThrow();
      expect(() => s.parse({ account: "work", to: ["not-an-address"], subject: "x", body: "y" })).toThrow(/e-mail address/);
      expect(() => s.parse({ account: "work", to: ["Sam <sam@northwind.example>"], subject: "x", body: "y" })).not.toThrow();
      expect(() => defs.mail_search!.inputSchema.parse({ account: "work", query: "x", limit: 51 })).toThrow();
      expect(() => defs.mail_draft!.inputSchema.parse({ account: "work", to: [], subject: "x", body: "y" })).toThrow();
    });
  });

  describe("scope gating", () => {
    it("refuses every mail tool for an account without the Gmail scopes", async () => {
      for (const [name, args] of [
        ["mail_search", { account: "personal", query: "x", limit: 20 }],
        ["mail_read", { account: "personal", threadId: "ta", maxChars: 1000 }],
        ["mail_labels", { account: "personal" }],
        ["mail_draft", { account: "personal", to: ["a@b.com"], subject: "s", body: "b" }],
        ["mail_send", { account: "personal", to: ["a@b.com"], subject: "s", body: "b" }],
        ["mail_reply", { account: "personal", threadId: "ta", body: "b", replyAll: false }],
        ["mail_label", { account: "personal", threadId: "ta", add: ["TRASH"] }],
      ] as const) {
        const r = await call(tools, name, { ...args });
        expect(r.isError, name).toBe(true);
        expect(r.text).toMatch(/^Gmail not granted for personal; open .*\/connect and grant Gmail access$/);
      }
      expect(gmail.log).toHaveLength(0);
      expect(await readAudit()).toEqual([]);
    });
    it("reports gmail per account in the accounts tool", async () => {
      const r = await call(tools, "accounts", {});
      const rows = r.json!.accounts as { label: string; gmail: boolean }[];
      expect(rows.map((x) => [x.label, x.gmail])).toEqual([
        ["work", true],
        ["personal", false],
      ]);
    });
  });

  describe("mail_search", () => {
    it("returns threads newest first with the newest message's headers, unread and hasAttachments", async () => {
      const r = await call(tools, "mail_search", { account: "work", query: "in:anywhere", limit: 20 });
      const threads = r.json!.threads as Record<string, unknown>[];
      expect(threads.map((t) => t.threadId)).toEqual(["tc", "ta", "tb"]);
      expect(threads[1]).toMatchObject({
        threadId: "ta",
        messageId: "a2",
        from: `Alex <${WORK}>`,
        to: ["Sam <sam@northwind.example>"],
        subject: "Re: Survey report",
        unread: true,
        hasAttachments: true,
        messageCount: 2,
      });
      expect(threads[1]!.labels).toEqual(["INBOX", "SENT", "UNREAD"]);
      expect(threads[2]).toMatchObject({ unread: false, hasAttachments: false, subject: "Utilisation certificate Q2" });
      expect(gmail.log[0]!.params.get("q")).toBe("in:anywhere");
    });
    it("filters with Gmail syntax and pages", async () => {
      const r = await call(tools, "mail_search", { account: "work", query: "is:unread", limit: 1 });
      expect((r.json!.threads as { threadId: string }[]).map((t) => t.threadId)).toEqual(["tc"]);
      expect(r.json!.nextPageToken).toBe("1");
      const r2 = await call(tools, "mail_search", { account: "work", query: "is:unread", limit: 1, pageToken: "1" });
      expect((r2.json!.threads as { threadId: string }[]).map((t) => t.threadId)).toEqual(["ta"]);
      expect(r2.json!.nextPageToken).toBeUndefined();
    });
  });

  describe("mail_read", () => {
    it("reads a thread oldest first with plain bodies and attachment metadata", async () => {
      const r = await call(tools, "mail_read", { account: "work", threadId: "ta", maxChars: 20000 });
      const ms = r.json!.messages as Record<string, unknown>[];
      expect(ms.map((m) => m.messageId)).toEqual(["a1", "a2"]);
      expect(ms[0]).toMatchObject({ from: "Sam <sam@northwind.example>", to: [WORK], cc: ["team@acme.example"], subject: "Survey report", body: "Please find the survey attached.", unread: true });
      expect(ms[0]!.attachments).toEqual([{ filename: "Survey.pdf", mimeType: "application/pdf", size: 5000, attachmentId: "att-a1-0", partId: "2", index: 0, messageId: "a1" }]);
      expect(r.json!.webLink).toBe(`https://mail.google.com/mail/?authuser=${encodeURIComponent(WORK)}#all/ta`);
    });
    it("renders an html-only message as text and honours maxChars", async () => {
      const r = await call(tools, "mail_read", { account: "work", messageId: "b1", maxChars: 20000 });
      const m = (r.json!.messages as Record<string, unknown>[])[0]!;
      expect(m.body).toBe("Dear Sir,\nplease submit by Friday.");
      const cut = await call(tools, "mail_read", { account: "work", messageId: "b1", maxChars: 100 });
      expect((cut.json!.messages as Record<string, unknown>[])[0]).toMatchObject({ body: "Dear Sir,\nplease submit by Friday.", bodyTruncated: false });
    });
    it("needs exactly one of messageId or threadId", async () => {
      expect((await call(tools, "mail_read", { account: "work", maxChars: 1000 })).text).toMatch(/exactly one/);
      expect((await call(tools, "mail_read", { account: "work", messageId: "a1", threadId: "ta", maxChars: 1000 })).text).toMatch(/exactly one/);
    });
  });

  describe("mail_draft", () => {
    it("creates a draft with text+html, Drive attachments (native exported to PDF) and audits recipients and subject", async () => {
      const r = await call(tools, "mail_draft", {
        account: "work",
        to: ["Sam <sam@northwind.example>"],
        cc: ["team@acme.example"],
        bcc: [PERSONAL],
        subject: "Ankündigung: survey",
        body: "Hi Sam,\n\nsee https://example.com and the attached.\n\n- one\n- two",
        attachments: [{ driveFileId: "rep" }, { driveFileId: "gdoc" }, { driveFileId: "pnote", account: "personal" }],
      });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toMatchObject({ account: "work", draftId: expect.stringMatching(/^d/), threadId: expect.any(String), subject: "Ankündigung: survey" });
      expect(r.json!.webLink).toMatch(/#drafts\//);
      expect(r.json!.attachments).toEqual([
        { driveFileId: "rep", account: "work", filename: "2026-01-05_Acme_Report.pdf", mimeType: "application/pdf", size: 12 },
        { driveFileId: "gdoc", account: "work", filename: "Board notes.pdf", mimeType: "application/pdf", size: "PDF(Board notes)".length },
        { driveFileId: "pnote", account: "personal", filename: "2026-02-01_Personal_Note.txt", mimeType: "text/plain", size: 5 },
      ]);
      const draft = Object.values(gmail.drafts)[0]!;
      expect(draft.headers.from).toBe(WORK);
      expect(draft.headers.to).toBe("Sam <sam@northwind.example>");
      expect(draft.headers.cc).toBe("team@acme.example");
      expect(draft.headers.bcc).toBe(PERSONAL);
      expect(draft.headers.subject).toBe(`=?UTF-8?B?${Buffer.from("Ankündigung: survey").toString("base64")}?=`);
      expect(draft.headers["content-type"]).toMatch(/^multipart\/mixed/);
      expect(draft.text).toBe("Hi Sam,\r\n\r\nsee https://example.com and the attached.\r\n\r\n- one\r\n- two");
      expect(draft.hasHtml).toBe(true);
      expect(draft.attachments).toEqual(["2026-01-05_Acme_Report.pdf", "Board notes.pdf", "2026-02-01_Personal_Note.txt"]);
      expect(gmail.sent).toHaveLength(0);
      const audit = await readAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        tool: "mail_draft",
        account: "work",
        recipients: ["Sam <sam@northwind.example>", "team@acme.example", PERSONAL],
        subject: "Ankündigung: survey",
        attachments: ["2026-01-05_Acme_Report.pdf", "Board notes.pdf", "2026-02-01_Personal_Note.txt"],
        draftId: r.json!.draftId,
      });
    });
    it("threads a reply draft with In-Reply-To/References and the original threadId", async () => {
      const r = await call(tools, "mail_draft", { account: "work", to: ["sam@northwind.example"], subject: "Re: Survey report", body: "Done.", replyToMessageId: "a1" });
      expect(r.isError, r.text).toBe(false);
      expect(r.json!.threadId).toBe("ta");
      const draft = Object.values(gmail.drafts)[0]!;
      expect(draft.headers["in-reply-to"]).toBe("<a1@mail.gmail.com>");
      expect(draft.headers.references).toBe("<a1@mail.gmail.com>");
      expect(draft.threadId).toBe("ta");
    });
    it("refuses folders and attachments over 20 MB before touching Gmail", async () => {
      const f = await call(tools, "mail_draft", { account: "work", to: ["a@b.com"], subject: "s", body: "b", attachments: [{ driveFileId: "folder" }] });
      expect(f.text).toMatch(/Cannot attach a folder/);
      const big = await call(tools, "mail_draft", { account: "work", to: ["a@b.com"], subject: "s", body: "b", attachments: [{ driveFileId: "big" }] });
      expect(big.text).toMatch(/exceed 20 MB/);
      expect(gmail.log.filter((l) => l.method === "POST")).toHaveLength(0);
      expect(await readAudit()).toEqual([]);
    });
  });

  describe("mail_send", () => {
    it("sends a new message and audits it", async () => {
      const r = await call(tools, "mail_send", { account: "work", to: ["sam@northwind.example"], subject: "Hello", body: "Body" });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toMatchObject({ sent: true, messageId: expect.any(String), threadId: expect.any(String) });
      expect(gmail.sent).toHaveLength(1);
      expect(gmail.sent[0]!.headers).toMatchObject({ from: WORK, to: "sam@northwind.example", subject: "Hello" });
      expect((await readAudit())[0]).toMatchObject({ tool: "mail_send", account: "work", recipients: ["sam@northwind.example"], subject: "Hello", messageId: r.json!.messageId });
    });
    it("sends an existing draft", async () => {
      const d = await call(tools, "mail_draft", { account: "work", to: ["sam@northwind.example"], subject: "Draft first", body: "Body" });
      const r = await call(tools, "mail_send", { account: "work", draftId: d.json!.draftId });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toMatchObject({ sent: true, draftId: d.json!.draftId });
      expect(gmail.sent.map((s) => s.headers.subject)).toEqual(["Draft first"]);
      expect(Object.keys(gmail.drafts)).toEqual([]);
      const audit = await readAudit();
      expect(audit.map((e) => e.tool)).toEqual(["mail_send", "mail_draft"]);
      expect(audit[0]).toMatchObject({ draftId: d.json!.draftId, subject: "Draft first", recipients: ["sam@northwind.example"] });
    });
    it("rejects draftId mixed with message fields, and missing fields", async () => {
      expect((await call(tools, "mail_send", { account: "work", draftId: "d1", subject: "x" })).text).toMatch(/draftId alone/);
      expect((await call(tools, "mail_send", { account: "work", to: ["a@b.com"] })).text).toMatch(/to \+ subject \+ body/);
      expect(gmail.sent).toHaveLength(0);
    });
  });

  describe("mail_reply", () => {
    it("replies to the newest message with correct headers; when it is my own, to its recipients", async () => {
      const r = await call(tools, "mail_reply", { account: "work", threadId: "ta", body: "Following up.", replyAll: false });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toMatchObject({ sent: true, threadId: "ta", inReplyTo: "a2", to: ["Sam <sam@northwind.example>"], cc: [], subject: "Re: Survey report" });
      const s = gmail.sent[0]!;
      expect(s.headers["in-reply-to"]).toBe("<a2@mail.gmail.com>");
      expect(s.headers.references).toBe("<a2@mail.gmail.com>");
      expect(s.headers.subject).toBe("Re: Survey report");
      expect(s.threadId).toBe("ta");
      expect((await readAudit())[0]).toMatchObject({ tool: "mail_reply", threadId: "ta", recipients: ["Sam <sam@northwind.example>"] });
    });
    it("replyAll copies the other recipients but never the sender itself", async () => {
      gmail.boxes.work!.push({ id: "a3", threadId: "ta", date: T0 + 7_200_000, from: "Sam <sam@northwind.example>", to: [`Alex <${WORK}>`, "ops@acme.example"], cc: ["team@acme.example"], subject: "Re: Survey report", text: "ok" });
      const r = await call(tools, "mail_reply", { account: "work", threadId: "ta", body: "Thanks all.", replyAll: true });
      expect(r.isError, r.text).toBe(false);
      expect(r.json).toMatchObject({ inReplyTo: "a3", to: ["Sam <sam@northwind.example>"], cc: ["ops@acme.example", "team@acme.example"] });
      expect(gmail.sent[0]!.headers.cc).toBe("ops@acme.example, team@acme.example");
    });
    it("honours Reply-To and does not add a second Re:", async () => {
      gmail.boxes.work!.push({ id: "a4", threadId: "ta", date: T0 + 9_000_000, from: "noreply@northwind.example", replyTo: "helpdesk@northwind.example", to: [WORK], subject: "RE: Survey report", text: "ok" });
      const r = await call(tools, "mail_reply", { account: "work", threadId: "ta", body: "Hi", replyAll: false });
      expect(r.json).toMatchObject({ to: ["helpdesk@northwind.example"], subject: "RE: Survey report" });
    });
  });

  describe("labels", () => {
    it("lists labels", async () => {
      const r = await call(tools, "mail_labels", { account: "work" });
      const names = (r.json!.labels as { name: string }[]).map((l) => l.name);
      expect(names).toContain("INBOX");
      expect(names).toContain("Northwind");
    });
    it("archives a thread, trashes a message by label name and marks read, all audited", async () => {
      const a = await call(tools, "mail_label", { account: "work", threadId: "ta", remove: ["INBOX"], markRead: true });
      expect(a.isError, a.text).toBe(false);
      expect(a.json).toMatchObject({ threadId: "ta", added: [], removed: ["INBOX", "UNREAD"] });
      expect(gmail.boxes.work!.find((m) => m.id === "a1")!.labelIds).toEqual([]);
      const t = await call(tools, "mail_label", { account: "work", messageId: "c1", add: ["trash", "Northwind"], markRead: false });
      expect(t.json).toMatchObject({ messageId: "c1", added: ["TRASH", "Label_1", "UNREAD"], removed: [] });
      expect(gmail.boxes.work!.find((m) => m.id === "c1")!.labelIds).toEqual(["INBOX", "UNREAD", "Label_1", "TRASH"]);
      const audit = await readAudit();
      expect(audit.map((e) => e.tool)).toEqual(["mail_label", "mail_label"]);
      expect(audit[1]).toMatchObject({ threadId: "ta", remove: ["INBOX", "UNREAD"] });
    });
    it("rejects unknown labels and empty changes without calling modify", async () => {
      expect((await call(tools, "mail_label", { account: "work", messageId: "c1", add: ["Nope"] })).text).toMatch(/Unknown label "Nope"/);
      expect((await call(tools, "mail_label", { account: "work", messageId: "c1" })).text).toMatch(/Nothing to change/);
      expect((await call(tools, "mail_label", { account: "work", add: ["TRASH"] })).text).toMatch(/exactly one/);
      expect(gmail.log.filter((l) => l.path.endsWith("/modify"))).toHaveLength(0);
    });
    it("never exposes a permanent delete", () => {
      expect(Object.keys(tools).filter((n) => /delete|purge/i.test(n))).toEqual([]);
    });
  });
});
