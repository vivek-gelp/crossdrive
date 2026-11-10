/**
 * RFC 2822 / MIME message builder for the Gmail tools, plus the two text
 * converters: a small markdown-ish renderer for the text/html alternative and
 * html -> plain text for reading messages. Pure functions, no I/O.
 */

export interface MimeAttachment {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface MimeInput {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain-text body (LF or CRLF line endings; normalised to CRLF). */
  text: string;
  /** Optional HTML alternative of `text`. */
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MimeAttachment[];
  date?: Date;
}

const CRLF = "\r\n";

// ---- encoding helpers --------------------------------------------------------

export function base64Url(data: string | Uint8Array): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return new Uint8Array(Buffer.from(b64 + "=".repeat((4 - (b64.length % 4)) % 4), "base64"));
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word when the value is not printable ASCII. */
export function encodeHeaderWord(value: string): string {
  if (isAscii(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

/** `Name <addr>` with the display name RFC 2047-encoded when needed; bare addresses pass through. */
export function formatAddress(addr: string): string {
  const m = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(addr);
  if (!m) return addr.trim();
  const name = m[1]!;
  if (!name) return m[2]!;
  if (isAscii(name)) return `${name} <${m[2]}>`;
  return `${encodeHeaderWord(name.replace(/^"|"$/g, ""))} <${m[2]}>`;
}

/** Base64 body folded at 76 characters, as RFC 2045 requires. */
function base64Lines(data: string | Uint8Array): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return buf.toString("base64").replace(/.{1,76}/g, (line) => line + CRLF);
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  if (isAscii(filename) && !/"/.test(filename)) return `Content-Disposition: attachment; filename="${filename}"`;
  return `Content-Disposition: attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function boundary(tag: string): string {
  return `=_crossdrive_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function textPart(mime: "text/plain" | "text/html", body: string): string {
  return [`Content-Type: ${mime}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", base64Lines(body)].join(CRLF);
}

/** Build the raw RFC 2822 message (CRLF line endings). Feed the result to `base64Url` for Gmail's `raw` field. */
export function buildMime(input: MimeInput): string {
  const to = input.to.filter(Boolean);
  if (to.length === 0 && !(input.cc ?? []).length && !(input.bcc ?? []).length) throw new Error("At least one recipient (to, cc or bcc) is required");
  const text = input.text.replace(/\r?\n/g, CRLF);

  const headers: string[] = [
    `From: ${formatAddress(input.from)}`,
    `To: ${to.map(formatAddress).join(", ")}`,
  ];
  if (input.cc?.length) headers.push(`Cc: ${input.cc.map(formatAddress).join(", ")}`);
  if (input.bcc?.length) headers.push(`Bcc: ${input.bcc.map(formatAddress).join(", ")}`);
  headers.push(`Subject: ${encodeHeaderWord(input.subject)}`);
  headers.push(`Date: ${(input.date ?? new Date()).toUTCString().replace(/GMT$/, "+0000")}`);
  if (input.inReplyTo) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) headers.push(`References: ${input.references}`);
  headers.push("MIME-Version: 1.0");

  // Body: plain, or alternative(plain, html); either wrapped in mixed when there are attachments.
  let body: string;
  if (input.html !== undefined) {
    const alt = boundary("alt");
    body =
      [`Content-Type: multipart/alternative; boundary="${alt}"`, "", `--${alt}`, textPart("text/plain", text), `--${alt}`, textPart("text/html", input.html.replace(/\r?\n/g, CRLF))].join(
        CRLF,
      ) + `--${alt}--${CRLF}`;
  } else {
    body = textPart("text/plain", text);
  }

  if (input.attachments?.length) {
    const mixed = boundary("mix");
    const parts = input.attachments.map((a) =>
      [
        `Content-Type: ${a.mimeType}; name="${encodeHeaderWord(a.filename).replace(/"/g, "'")}"`,
        contentDisposition(a.filename),
        "Content-Transfer-Encoding: base64",
        "",
        base64Lines(a.bytes),
      ].join(CRLF),
    );
    body =
      [`Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`, body, ...parts.flatMap((p) => [`--${mixed}`, p])].join(CRLF) +
      `--${mixed}--${CRLF}`;
  }

  return headers.join(CRLF) + CRLF + body;
}

// ---- markdown-ish -> html ----------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline: `[text](url)`, bare http(s) links and `**bold**`, on already-escaped text. */
function inline(escaped: string): string {
  const links: string[] = [];
  const hold = (html: string) => `\u0000${links.push(html) - 1}\u0000`;
  let s = escaped.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => hold(`<a href="${u}">${t}</a>`));
  s = s.replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => hold(`<a href="${u}">${u}</a>`));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => links[Number(i)]!);
}

/**
 * Render plain text to simple HTML: blank-line separated paragraphs, `<br>`
 * within a paragraph, `- ` / `* ` bullet lines as a list, links and bold.
 */
export function renderHtml(text: string): string {
  const blocks = text.replace(/\r\n/g, "\n").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    let para: string[] = [];
    let items: string[] = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map((l) => inline(escapeHtml(l))).join("<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (items.length) out.push(`<ul>${items.map((l) => `<li>${inline(escapeHtml(l))}</li>`).join("")}</ul>`);
      items = [];
    };
    for (const line of lines) {
      const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
      if (bullet) {
        flushPara();
        items.push(bullet[1]!);
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
  }
  return out.join("");
}

// ---- html -> text ------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const key = e.toLowerCase();
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return ENTITIES[key] ?? m;
  });
}

/** Plain text rendering of an HTML body: block tags become line breaks, list items bullets, links keep their URL. */
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/\s+/g, " ");
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const t = inner.replace(/<[^>]+>/g, "").trim();
    const url = decodeEntities(href.trim());
    return !t ? url : t === url || !/^https?:/i.test(url) ? t : `${t} (${url})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|tr|table|ul|ol|h[1-6]|blockquote|pre|section|article|header|footer)>/gi, "\n\n");
  s = s.replace(/<(p|div|tr|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(td|th)>/gi, "\t");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
