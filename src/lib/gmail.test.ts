import { describe, expect, it } from "vitest";
import { extractEmail, parseAddressList, parseMessage, summarizeThread, type GmailMessage } from "./gmail";
import { base64Url } from "./mime";

describe("address parsing", () => {
  it("splits on commas outside quotes and angle brackets", () => {
    expect(parseAddressList('"Müller, Jürgen" <j@x.com>, a@b.com, Team <t@x.com>')).toEqual(['"Müller, Jürgen" <j@x.com>', "a@b.com", "Team <t@x.com>"]);
    expect(parseAddressList(undefined)).toEqual([]);
  });
  it("extracts the bare lower-cased address", () => {
    expect(extractEmail("Alex <Alex@Acme.example>")).toBe("alex@acme.example");
    expect(extractEmail("  a@b.com ")).toBe("a@b.com");
  });
});

function msg(over: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Hello there",
    internalDate: "1767225600000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Team <team@x.com>" },
        { name: "To", value: "alex@acme.example, b@x.com" },
        { name: "Cc", value: "c@x.com" },
        { name: "Subject", value: "Survey" },
        { name: "Message-ID", value: "<abc@mail.gmail.com>" },
        { name: "Content-Type", value: "multipart/mixed; boundary=z" },
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { size: 5, data: base64Url("Plain body") } },
            { mimeType: "text/html", body: { size: 9, data: base64Url("<p>Html body</p>") } },
          ],
        },
        { mimeType: "application/pdf", filename: "Survey.pdf", body: { size: 1234, attachmentId: "att1" } },
      ],
    },
    ...over,
  };
}

describe("parseMessage", () => {
  it("prefers text/plain, lists attachments and reads headers", () => {
    const p = parseMessage(msg());
    expect(p).toMatchObject({
      messageId: "m1",
      threadId: "t1",
      from: "Team <team@x.com>",
      to: ["alex@acme.example", "b@x.com"],
      cc: ["c@x.com"],
      subject: "Survey",
      date: "2026-01-01T00:00:00.000Z",
      unread: true,
      body: "Plain body",
      bodyTruncated: false,
      rfcMessageId: "<abc@mail.gmail.com>",
    });
    expect(p.attachments).toEqual([{ filename: "Survey.pdf", mimeType: "application/pdf", size: 1234, attachmentId: "att1", partId: undefined, index: 0, messageId: "m1" }]);
  });
  it("renders html to text when there is no plain part and never returns tags", () => {
    const m = msg({ payload: { mimeType: "text/html", headers: [{ name: "Subject", value: "H" }], body: { size: 1, data: base64Url("<div>Hi<br><b>there</b> &amp; co</div>") } } });
    const p = parseMessage(m);
    expect(p.body).toBe("Hi\nthere & co");
    expect(p.body).not.toMatch(/<[a-z]/);
  });
  it("truncates the body at maxChars", () => {
    const p = parseMessage(msg(), 5);
    expect(p.body).toBe("Plain");
    expect(p.bodyTruncated).toBe(true);
  });
});

describe("summarizeThread", () => {
  it("summarises from the newest message and unions labels", () => {
    const older = msg({ id: "m0", internalDate: "1767139200000", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "a@x.com" }, { name: "Subject", value: "Survey" }, { name: "Content-Type", value: "text/plain" }] } });
    const newer = msg({ payload: { headers: msg().payload!.headers } });
    const s = summarizeThread({ id: "t1", messages: [newer, older] });
    expect(s).toMatchObject({ threadId: "t1", messageId: "m1", from: "Team <team@x.com>", subject: "Survey", unread: true, hasAttachments: true, messageCount: 2, labels: ["INBOX", "UNREAD"] });
  });
  it("is undefined for an empty thread", () => {
    expect(summarizeThread({ id: "t" })).toBeUndefined();
  });
});
