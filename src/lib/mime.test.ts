import { describe, expect, it } from "vitest";
import { base64Url, buildMime, decodeBase64Url, encodeHeaderWord, formatAddress, htmlToText, renderHtml } from "./mime";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

function headersOf(raw: string): Record<string, string> {
  const head = raw.split("\r\n\r\n")[0]!;
  const out: Record<string, string> = {};
  for (const line of head.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

describe("base64url", () => {
  it("round-trips bytes without padding or +/", () => {
    const enc = base64Url("hi there? yes/no+maybeÿþ");
    expect(enc).not.toMatch(/[+/=]/);
    expect(Buffer.from(decodeBase64Url(enc)).toString("utf8")).toBe("hi there? yes/no+maybeÿþ");
  });
});

describe("header encoding", () => {
  it("leaves ASCII alone and RFC 2047-encodes anything else", () => {
    expect(encodeHeaderWord("Plain subject")).toBe("Plain subject");
    expect(encodeHeaderWord("Ankündigung Northwind")).toBe(`=?UTF-8?B?${b64("Ankündigung Northwind")}?=`);
  });
  it("formats addresses with an optional display name", () => {
    expect(formatAddress("a@b.com")).toBe("a@b.com");
    expect(formatAddress("Alex S <a@b.com>")).toBe("Alex S <a@b.com>");
    expect(formatAddress("Jürgen Müller <j@b.com>")).toBe(`=?UTF-8?B?${b64("Jürgen Müller")}?= <j@b.com>`);
    expect(formatAddress('"Quoted, Name" <q@b.com>')).toBe('"Quoted, Name" <q@b.com>');
  });
});

describe("buildMime", () => {
  const base = { from: "alex@acme.example", to: ["a@b.com"], subject: "Hello", text: "Body line 1\n\nBody line 2" };

  it("builds a single-part text/plain message with CRLF, Date and MIME-Version", () => {
    const raw = buildMime(base);
    expect(raw).not.toMatch(/[^\r]\n/);
    const h = headersOf(raw);
    expect(h.from).toBe("alex@acme.example");
    expect(h.to).toBe("a@b.com");
    expect(h.subject).toBe("Hello");
    expect(h["mime-version"]).toBe("1.0");
    expect(h.date).toMatch(/\d{4}/);
    expect(h["content-type"]).toBe('text/plain; charset="UTF-8"');
    expect(h["content-transfer-encoding"]).toBe("base64");
    const body = raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Body line 1\r\n\r\nBody line 2");
  });

  it("puts cc and bcc in headers and encodes a UTF-8 subject", () => {
    const h = headersOf(buildMime({ ...base, cc: ["c@b.com", "d@b.com"], bcc: ["e@b.com"], subject: "Über uns" }));
    expect(h.cc).toBe("c@b.com, d@b.com");
    expect(h.bcc).toBe("e@b.com");
    expect(h.subject).toBe(`=?UTF-8?B?${b64("Über uns")}?=`);
  });

  it("adds In-Reply-To and References for replies", () => {
    const h = headersOf(buildMime({ ...base, inReplyTo: "<m1@mail.gmail.com>", references: "<m0@mail.gmail.com> <m1@mail.gmail.com>" }));
    expect(h["in-reply-to"]).toBe("<m1@mail.gmail.com>");
    expect(h.references).toBe("<m0@mail.gmail.com> <m1@mail.gmail.com>");
  });

  it("emits multipart/alternative when an html part is given", () => {
    const raw = buildMime({ ...base, html: "<p>Body</p>" });
    const h = headersOf(raw);
    expect(h["content-type"]).toMatch(/^multipart\/alternative; boundary="([^"]+)"$/);
    const boundary = /boundary="([^"]+)"/.exec(h["content-type"]!)![1]!;
    const parts = raw.split(`--${boundary}`);
    expect(parts).toHaveLength(4); // preamble, text, html, closing
    expect(parts[1]).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(parts[2]).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(parts[3]!.startsWith("--")).toBe(true);
  });

  it("wraps attachments in multipart/mixed with base64 lines of at most 76 chars and RFC 2231 filenames", () => {
    const bytes = new Uint8Array(200).map((_, i) => i);
    const raw = buildMime({
      ...base,
      html: "<p>Body</p>",
      attachments: [
        { filename: "2026-01-05_Acme_Report.pdf", mimeType: "application/pdf", bytes },
        { filename: "Übersicht.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes },
      ],
    });
    const h = headersOf(raw);
    expect(h["content-type"]).toMatch(/^multipart\/mixed; boundary="([^"]+)"$/);
    const outer = /boundary="([^"]+)"/.exec(h["content-type"]!)![1]!;
    const parts = raw.split(`--${outer}`);
    expect(parts).toHaveLength(5); // preamble, alternative, att1, att2, closing
    expect(parts[1]).toMatch(/Content-Type: multipart\/alternative; boundary="[^"]+"/);
    expect(parts[2]).toContain('Content-Type: application/pdf; name="2026-01-05_Acme_Report.pdf"');
    expect(parts[2]).toContain('Content-Disposition: attachment; filename="2026-01-05_Acme_Report.pdf"');
    expect(parts[2]).toContain("Content-Transfer-Encoding: base64");
    expect(parts[3]).toContain("filename*=UTF-8''%C3%9Cbersicht.xlsx");
    const attBody = parts[2]!.split("\r\n\r\n")[1]!.trim();
    for (const line of attBody.split("\r\n")) expect(line.length).toBeLessThanOrEqual(76);
    expect(Buffer.from(attBody.replace(/\r\n/g, ""), "base64")).toEqual(Buffer.from(bytes));
  });

  it("refuses a message without recipients", () => {
    expect(() => buildMime({ ...base, to: [] })).toThrow(/recipient/);
  });
});

describe("renderHtml", () => {
  it("escapes html, makes paragraphs, line breaks, links and bold", () => {
    const html = renderHtml("Hi <b>there</b>,\nsee https://example.com/a?b=1 and [the doc](https://docs.example.com).\n\n**Thanks**\nAlex");
    expect(html).toBe(
      "<p>Hi &lt;b&gt;there&lt;/b&gt;,<br>see <a href=\"https://example.com/a?b=1\">https://example.com/a?b=1</a> and <a href=\"https://docs.example.com\">the doc</a>.</p>" +
        "<p><b>Thanks</b><br>Alex</p>",
    );
  });
  it("renders - and * bullet lines as a list", () => {
    expect(renderHtml("Items:\n- one\n- two")).toBe("<p>Items:</p><ul><li>one</li><li>two</li></ul>");
  });
});

describe("htmlToText", () => {
  it("drops tags, scripts and styles, keeps block structure and decodes entities", () => {
    const text = htmlToText(
      '<html><head><style>p{color:red}</style><script>x()</script></head><body><div>Hello&nbsp;<b>Alex</b>,</div><p>Line&amp;one<br>two</p><ul><li>A &lt; B</li><li>C</li></ul><a href="https://x.y/z">link</a></body></html>',
    );
    expect(text).toBe("Hello Alex,\n\nLine&one\ntwo\n\n- A < B\n- C\n\nlink (https://x.y/z)");
  });
  it("collapses runs of blank lines and trims", () => {
    expect(htmlToText("<p></p><p>  a  </p><p></p><p></p><p>b</p>  ")).toBe("a\n\nb");
  });
  it("does not repeat the url when the anchor text is the url", () => {
    expect(htmlToText('<a href="https://x.y">https://x.y</a>')).toBe("https://x.y");
  });
});
