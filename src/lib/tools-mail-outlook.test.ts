import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { connectedAccountRecord } from "./accounts";
import { readAudit } from "./audit";
import { setMailFetch } from "./mail";
import { toKql } from "./outlook";
import { setProviderFetch } from "./providers/env";
import { fakeOneDrive, type FakeOneDrive } from "./providers/testing/fakeOneDrive";
import { clearProviderTokens, msGrantedScopes, msRefreshScopes } from "./providers/tokens";
import { mailGranted, setStore } from "./store";
import { memoryStore } from "./testing/fakeDrive";
import { fakeOutlook, type FakeOutlook, type FakeOutlookMessage } from "./testing/fakeOutlook";
import { registerAllTools } from "./tools";

const MAIL = ["offline_access", "Files.ReadWrite.All", "User.Read", "Mail.ReadWrite", "Mail.Send"];

vi.mock("./store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store")>();
  const accounts = [
    { label: "hotmail", email: "alex@outlook.com", provider: "microsoft", mail: "send", scopes: ["offline_access", "Files.ReadWrite.All", "User.Read", "Mail.ReadWrite", "Mail.Send"] },
    { label: "contoso", email: "alex@contoso.example", provider: "microsoft", mail: "draft", scopes: ["offline_access", "Files.ReadWrite.All", "User.Read", "Mail.ReadWrite", "Mail.Send"] },
    { label: "files", email: "files@contoso.example", provider: "microsoft", mail: "off", scopes: ["offline_access", "Files.ReadWrite.All", "User.Read"] },
  ].map((a) => ({ ...a, refresh_token: `rt-${a.label}`, connectedAt: "2026-01-01T00:00:00Z" }));
  return {
    ...orig,
    accessTokenFor: async () => {
      throw new Error("no Google accounts in this test");
    },
    getAccount: async (label: string) => {
      const a = accounts.find((x) => x.label === label);
      if (!a) throw new Error(`No connected account labelled "${label}"`);
      return a;
    },
    loadAccounts: async () => accounts,
    upsertAccount: async () => accounts,
  };
});

type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;

function collect(register: (s: McpServer) => void) {
  const tools: Record<string, Handler> = {};
  const server = { registerTool: (name: string, _d: unknown, h: Handler) => void (tools[name] = h) } as unknown as McpServer;
  register(server);
  return tools;
}

async function call(tools: Record<string, Handler>, name: string, args: Record<string, unknown>) {
  const r = await tools[name]!(args, {} as ServerContext);
  const text = r.content[0]?.text ?? "";
  return { isError: r.isError === true, text, json: r.isError ? undefined : (JSON.parse(text) as Record<string, unknown>) };
}

const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
function inbox(): FakeOutlookMessage[] {
  return [
    {
      id: "m1",
      conversationId: "conv-a",
      folder: "inbox",
      subject: "Survey report",
      from: { name: "Sam", address: "sam@northwind.example" },
      to: ["alex@outlook.com"],
      cc: ["team@northwind.example"],
      isRead: false,
      date: T0,
      internetMessageId: "<m1@northwind.example>",
      body: "Please find the survey attached.",
      attachments: [
        { id: "att-1", name: "Survey.csv", contentType: "text/csv", content: "site,kw\nNeppathur,250" },
        { id: "att-2", name: "Fwd.eml", contentType: "message/rfc822", content: "x", item: true },
      ],
    },
    { id: "m2", conversationId: "conv-a", folder: "sentitems", subject: "Re: Survey report", from: { name: "Alex", address: "alex@outlook.com" }, to: ["sam@northwind.example"], date: T0 + 3_600_000, body: "Thanks, reviewing." },
    { id: "m3", conversationId: "conv-b", folder: "inbox", subject: "Weekly digest", from: { address: "news@example.com" }, to: ["alex@outlook.com"], date: T0 - 86_400_000, body: "News", categories: ["Newsletters"] },
  ];
}

describe("mail tools on Outlook accounts", () => {
  let tools: Record<string, Handler>;
  let mail: FakeOutlook;
  let ms: FakeOneDrive;

  beforeEach(() => {
    process.env.MS_CLIENT_ID = "ms-client";
    process.env.MS_CLIENT_SECRET = "ms-secret";
    setStore(memoryStore());
    clearProviderTokens();
    mail = fakeOutlook({ hotmail: inbox(), contoso: [], files: [] }, ["Newsletters", "Clients"]);
    ms = fakeOneDrive(["hotmail", "contoso", "files"]);
    ms.put("hotmail", "/Docs/2026-11-01_Acme_Quote.txt", "quote body");
    const route = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const toMail = u.hostname === "graph.microsoft.com" && /^\/v1\.0\/me\/(messages|mailFolders|outlook)/.test(u.pathname);
      return toMail ? mail.fetchImpl(input, init) : ms.fetchImpl(input, init);
    }) as typeof fetch;
    setProviderFetch(route);
    setMailFetch(route);
    tools = collect(registerAllTools);
  });

  afterEach(() => {
    setProviderFetch(undefined);
    setMailFetch(undefined);
    setStore(undefined);
  });

  it("mail_search groups by conversation and maps folders, read state and categories to labels", async () => {
    const r = await call(tools, "mail_search", { account: "hotmail", query: "survey", limit: 10 });
    expect(r.isError).toBe(false);
    const threads = r.json!.threads as { threadId: string; messageId: string; labels: string[]; unread: boolean; hasAttachments: boolean; messageCount: number; from: string }[];
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ threadId: "conv-a", messageId: "m2", messageCount: 2, unread: true, hasAttachments: true });
    expect(threads[0]!.labels).toEqual(expect.arrayContaining(["INBOX", "SENT", "UNREAD"]));
    const digest = await call(tools, "mail_search", { account: "hotmail", query: "has:attachment", limit: 10 });
    expect((digest.json!.threads as unknown[]).length).toBe(1);
    const cat = await call(tools, "mail_search", { account: "hotmail", query: "digest", limit: 10 });
    expect((cat.json!.threads as { labels: string[] }[])[0]!.labels).toContain("Newsletters");
  });

  it("is:unread without other terms becomes a $filter; with terms it filters the page", async () => {
    const unread = await call(tools, "mail_search", { account: "hotmail", query: "is:unread", limit: 10 });
    expect((unread.json!.threads as { threadId: string }[]).map((t) => t.threadId)).toEqual(["conv-a"]);
    expect(mail.log.some((l) => new URL(l.url).searchParams.get("$filter") === "isRead eq false")).toBe(true);
    const none = await call(tools, "mail_search", { account: "hotmail", query: "digest is:unread", limit: 10 });
    expect(none.json!.threads).toEqual([]);
  });

  it("mail_read returns the thread as text with stable attachment selectors; mail_attachment reads a file attachment", async () => {
    const r = await call(tools, "mail_read", { account: "hotmail", threadId: "conv-a" });
    expect(r.isError).toBe(false);
    const msgs = r.json!.messages as { messageId: string; from: string; to: string[]; cc: string[]; body: string; attachments: { filename: string; partId: string; index: number }[] }[];
    expect(msgs.map((m) => m.messageId)).toEqual(["m1", "m2"]);
    expect(msgs[0]).toMatchObject({ from: "Sam <sam@northwind.example>", to: ["alex@outlook.com"], cc: ["team@northwind.example"], body: "Please find the survey attached." });
    expect(msgs[0]!.attachments.map((a) => [a.filename, a.partId, a.index])).toEqual([
      ["Survey.csv", "att-1", 0],
      ["Fwd.eml", "att-2", 1],
    ]);
    expect(r.json!.webLink).toBe("https://outlook.live.com/mail/0/");

    const a = await call(tools, "mail_attachment", { account: "hotmail", messageId: "m1", index: 0, maxChars: 20_000, offset: 0 });
    expect(a.isError).toBe(false);
    expect(a.json!.text).toContain("Neppathur");
    const item = await call(tools, "mail_attachment", { account: "hotmail", messageId: "m1", filename: "Fwd.eml" });
    expect(item.isError).toBe(true);
    expect(item.text).toMatch(/attached item or link/);
  });

  it("mail_send builds MIME, sends it as a draft, returns the Sent Items id and audits", async () => {
    const r = await call(tools, "mail_send", { account: "hotmail", to: ["Dana <dana@acme.example>"], bcc: ["boss@acme.example"], subject: "Quote", body: "Hi Dana,\n\nquote attached." });
    expect(r.isError).toBe(false);
    expect(mail.sent).toHaveLength(1);
    const sent = mail.sent[0]!.message;
    expect(r.json).toMatchObject({ sent: true, messageId: sent.id, threadId: sent.conversationId });
    expect(sent.folder).toBe("sentitems");
    expect(sent.raw).toMatch(/^From: alex@outlook.com/m);
    expect(sent.raw).toMatch(/^Bcc: boss@acme.example/m);
    expect(mail.log.find((l) => l.method === "POST" && l.url.endsWith("/v1.0/me/messages"))).toBeTruthy();
    const audit = await readAudit(50);
    expect(audit.find((e) => e.tool === "mail_send")).toMatchObject({ account: "hotmail", subject: "Quote", recipients: ["Dana <dana@acme.example>", "boss@acme.example"] });
  });

  it("attachments for an Outlook sender come from its own OneDrive by item id", async () => {
    const file = ms.get("hotmail", "/Docs/2026-11-01_Acme_Quote.txt")!;
    const r = await call(tools, "mail_draft", { account: "hotmail", to: ["dana@acme.example"], subject: "Quote", body: "Attached.", attachments: [{ driveFileId: file.id }] });
    expect(r.isError).toBe(false);
    expect(r.json!.attachments).toEqual([expect.objectContaining({ driveFileId: file.id, account: "hotmail", filename: "2026-11-01_Acme_Quote.txt", size: 10 })]);
    const draft = [...mail.mailboxes.get("hotmail")!.values()].find((m) => m.isDraft)!;
    expect(draft.raw).toContain("2026-11-01_Acme_Quote.txt");
    expect(mail.sent).toHaveLength(0);
  });

  it("mail_draft then mail_send {draftId} sends that draft; draft-only accounts refuse sending", async () => {
    const d = await call(tools, "mail_draft", { account: "hotmail", to: ["dana@acme.example"], subject: "Draft first", body: "Body" });
    expect(d.json!.webLink).toBe("https://outlook.live.com/mail/0/drafts");
    const s = await call(tools, "mail_send", { account: "hotmail", draftId: d.json!.draftId });
    expect(s.isError).toBe(false);
    expect(mail.sent.map((x) => x.message.subject)).toEqual(["Draft first"]);

    const refused = await call(tools, "mail_send", { account: "contoso", to: ["dana@acme.example"], subject: "x", body: "y" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/may only create drafts/);
    const ok = await call(tools, "mail_draft", { account: "contoso", to: ["dana@acme.example"], subject: "x", body: "y" });
    expect(ok.isError).toBe(false);
    expect(ok.json!.webLink).toBe("https://outlook.office.com/mail/drafts");
    expect(mail.sent).toHaveLength(1);
  });

  it("mail_reply answers the newest message from someone else's thread with threading headers", async () => {
    // Make the newest message an incoming one.
    mail.mailboxes.get("hotmail")!.get("m1")!.date = T0 + 7_200_000;
    const r = await call(tools, "mail_reply", { account: "hotmail", threadId: "conv-a", body: "Got it.", replyAll: true });
    expect(r.isError).toBe(false);
    expect(r.json).toMatchObject({ to: ["Sam <sam@northwind.example>"], cc: ["team@northwind.example"], subject: "Re: Survey report", inReplyTo: "m1" });
    const sent = mail.sent[0]!.message;
    expect(sent.raw).toMatch(/^In-Reply-To: <m1@northwind.example>/m);
    expect(sent.conversationId).toBe("conv-a");
  });

  it("mail_label: archive moves to Archive, TRASH to Deleted Items, markRead and categories patch; nothing is deleted", async () => {
    const dry = await call(tools, "mail_label", { account: "hotmail", messageId: "m1", remove: ["INBOX"], dryRun: true });
    expect(dry.json).toMatchObject({ dryRun: true, wouldRemove: ["INBOX"] });
    expect(mail.mailboxes.get("hotmail")!.get("m1")!.folder).toBe("inbox");

    const archived = await call(tools, "mail_label", { account: "hotmail", threadId: "conv-a", remove: ["INBOX"], markRead: true, add: ["Clients"] });
    expect(archived.isError).toBe(false);
    const box = mail.mailboxes.get("hotmail")!;
    expect(box.get("m1")).toMatchObject({ folder: "archive", isRead: true, categories: ["Clients"] });
    expect(box.get("m2")!.folder).toBe("sentitems");

    await call(tools, "mail_label", { account: "hotmail", messageId: "m3", add: ["TRASH"] });
    expect(box.get("m3")!.folder).toBe("deleteditems");
    await call(tools, "mail_label", { account: "hotmail", messageId: "m3", remove: ["TRASH"] });
    expect(box.get("m3")!.folder).toBe("inbox");
    expect(mail.log.some((l) => l.method === "DELETE")).toBe(false);

    const unknown = await call(tools, "mail_label", { account: "hotmail", messageId: "m3", add: ["Nope"] });
    expect(unknown.text).toMatch(/Unknown label "Nope"/);
  });

  it("mail_labels lists the system labels and Outlook categories", async () => {
    const r = await call(tools, "mail_labels", { account: "hotmail" });
    const names = (r.json!.labels as { name: string; type: string }[]).map((l) => `${l.type}:${l.name}`);
    expect(names).toEqual(expect.arrayContaining(["system:INBOX", "system:TRASH", "system:UNREAD", "user:Newsletters", "user:Clients"]));
  });

  it("a Microsoft account without the mail grant gets a reconnect hint", async () => {
    const r = await call(tools, "mail_search", { account: "files", query: "x", limit: 5 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/mail is turned off|Outlook mail not granted/);
  });
});

describe("Outlook scopes and records", () => {
  it("refreshes with the scopes the account consented to", () => {
    expect(msRefreshScopes({ scopes: ["drive"] })).toEqual(["offline_access", "Files.ReadWrite.All", "User.Read"]);
    expect(msRefreshScopes({ scopes: MAIL })).toEqual(MAIL);
    expect(msRefreshScopes({ scopes: ["Files.ReadWrite.All", "User.Read", "Mail.ReadWrite", "Mail.Send"] })[0]).toBe("offline_access");
  });

  it("reads Microsoft's granted scopes from Graph URIs", () => {
    expect(msGrantedScopes("https://graph.microsoft.com/Files.ReadWrite.All https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send", MAIL)).toEqual([
      "offline_access",
      "Files.ReadWrite.All",
      "User.Read",
      "Mail.Send",
    ]);
    expect(msGrantedScopes(undefined, MAIL)).toEqual(MAIL);
  });

  it("mailGranted needs both Outlook scopes; new and reconnected Microsoft records get mail by grant", () => {
    expect(mailGranted({ provider: "microsoft", scopes: MAIL })).toBe(true);
    expect(mailGranted({ provider: "microsoft", scopes: ["Mail.ReadWrite"] })).toBe(false);
    expect(mailGranted({ provider: "dropbox", scopes: MAIL })).toBe(false);
    const fresh = { label: "work", email: "w@x.example", refresh_token: "r", scopes: MAIL, provider: "microsoft" as const };
    expect(connectedAccountRecord(fresh, undefined).mail).toBe("draft");
    expect(connectedAccountRecord({ ...fresh, scopes: ["Files.ReadWrite.All"] }, undefined).mail).toBe("off");
    const old = { ...fresh, connectedAt: "", scopes: ["Files.ReadWrite.All"], mail: "off" as const };
    expect(connectedAccountRecord(fresh, old).mail).toBe("draft");
    expect(connectedAccountRecord(fresh, { ...old, scopes: MAIL, mail: "send" }).mail).toBe("send");
  });

  it("toKql rewrites the Gmail operators that have a KQL form", () => {
    const now = Date.UTC(2026, 10, 27);
    expect(toKql("from:sam has:attachment newer_than:7d", now)).toEqual({ kql: "from:sam hasattachments:true received>=2026-11-20", unread: undefined });
    expect(toKql("is:unread", now)).toEqual({ kql: "", unread: true });
    expect(toKql("in:inbox subject:Quote is:read", now)).toEqual({ kql: "subject:Quote", unread: false });
  });
});
