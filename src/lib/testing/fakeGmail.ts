/**
 * Test-only fake of the Gmail v1 REST surface the server uses. The bearer
 * token (`tok-<label>`) selects the mailbox. Messages are given as a flat
 * spec and served as Gmail payloads (single text/plain, or multipart with an
 * html alternative and attachments). Sent mail and drafts are recorded with
 * the parsed headers of their raw RFC 2822 message.
 *
 * No vitest imports here so the module can be loaded from `vi.mock` factories.
 */
import type { GmailLabel, GmailMessage, GmailPart, GmailThread } from "../gmail";

export interface FakeMessageSpec {
  id: string;
  threadId: string;
  /** Epoch ms. */
  date: number;
  from: string;
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text?: string;
  html?: string;
  /** `content` is served by messages.attachments.get (utf8, or latin1 bytes for binary types such as PDF); without it the attachment has metadata only. */
  attachments?: { filename: string; mimeType: string; size: number; content?: string }[];
  labelIds?: string[];
  snippet?: string;
  rfcMessageId?: string;
  references?: string;
}

export interface FakeMailboxSpec {
  label: string;
  email: string;
  messages: FakeMessageSpec[];
  labels?: GmailLabel[];
}

export interface FakeGmailOpts {
  /** Like real Gmail: every messages.get hands out new attachment ids and only the newest ones are accepted by attachments.get. */
  volatileAttachmentIds?: boolean;
}

export interface RawSummary {
  headers: Record<string, string>;
  text: string | undefined;
  hasHtml: boolean;
  attachments: string[];
  threadId?: string;
}

export interface FakeGmail {
  fetchImpl: typeof fetch;
  sent: RawSummary[];
  drafts: Record<string, RawSummary>;
  log: { method: string; path: string; params: URLSearchParams; body: unknown; account: string }[];
  /** Live message tables per account label. */
  boxes: Record<string, FakeMessageSpec[]>;
}

export const DEFAULT_LABELS: GmailLabel[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "TRASH", name: "TRASH", type: "system" },
  { id: "Label_1", name: "Northwind", type: "user" },
];

const b64url = (s: string, enc: BufferEncoding = "utf8") => Buffer.from(s, enc).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Headers and a few body facts of a base64url raw message (enough for assertions). */
export function parseRaw(raw: string): RawSummary {
  const msg = fromB64url(raw);
  const [head = ""] = msg.split("\r\n\r\n");
  const headers: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const plain = /Content-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]*?)(?:\r\n--|$)/.exec(msg);
  return {
    headers,
    text: plain ? Buffer.from(plain[1]!.replace(/\r\n/g, ""), "base64").toString("utf8") : undefined,
    hasHtml: /Content-Type: text\/html/.test(msg),
    attachments: [...msg.matchAll(/Content-Disposition: attachment; filename="([^"]+)"/g)].map((m) => m[1]!),
  };
}

let fetchSeq = 0;
/** Newest fetch sequence per message id, for volatile attachment ids. */
const latestFetch = new Map<string, number>();

function payloadOf(m: FakeMessageSpec, format: string, metadataHeaders: string[], volatile = false): GmailPart {
  const all: Record<string, string> = {
    From: m.from,
    To: m.to.join(", "),
    Subject: m.subject,
    Date: new Date(m.date).toUTCString(),
    "Message-ID": m.rfcMessageId ?? `<${m.id}@mail.gmail.com>`,
  };
  if (m.cc?.length) all.Cc = m.cc.join(", ");
  if (m.replyTo) all["Reply-To"] = m.replyTo;
  if (m.references) all.References = m.references;
  const multipart = !!m.html || !!m.attachments?.length;
  all["Content-Type"] = m.attachments?.length ? "multipart/mixed; boundary=x" : m.html ? "multipart/alternative; boundary=x" : 'text/plain; charset="UTF-8"';
  const wanted = format === "metadata" ? new Set(metadataHeaders.map((h) => h.toLowerCase())) : undefined;
  const headers = Object.entries(all)
    .filter(([k]) => !wanted || wanted.has(k.toLowerCase()))
    .map(([name, value]) => ({ name, value }));
  if (format === "metadata") return { mimeType: multipart ? "multipart/mixed" : "text/plain", headers };
  if (!multipart) return { mimeType: "text/plain", headers, body: { size: (m.text ?? "").length, data: b64url(m.text ?? "") } };
  const alt: GmailPart = m.html
    ? {
        mimeType: "multipart/alternative",
        parts: [
          ...(m.text !== undefined ? [{ mimeType: "text/plain", body: { size: m.text.length, data: b64url(m.text) } }] : []),
          { mimeType: "text/html", body: { size: m.html.length, data: b64url(m.html) } },
        ],
      }
    : { mimeType: "text/plain", body: { size: (m.text ?? "").length, data: b64url(m.text ?? "") } };
  if (!m.attachments?.length) return { ...alt, headers };
  let suffix = "";
  if (volatile && format === "full") {
    latestFetch.set(m.id, ++fetchSeq);
    suffix = `-v${fetchSeq}`;
  }
  return {
    mimeType: "multipart/mixed",
    headers,
    parts: [{ ...alt, partId: "1" }, ...m.attachments.map((a, i) => ({ partId: String(i + 2), mimeType: a.mimeType, filename: a.filename, body: { size: a.size, attachmentId: `att-${m.id}-${i}${suffix}` } }))],
  };
}

function toMessage(m: FakeMessageSpec, format: string, metadataHeaders: string[], volatile = false): GmailMessage {
  return { id: m.id, threadId: m.threadId, labelIds: m.labelIds ?? ["INBOX"], snippet: m.snippet ?? (m.text ?? "").slice(0, 60), internalDate: String(m.date), payload: payloadOf(m, format, metadataHeaders, volatile) };
}

/** Tiny Gmail query evaluator: from:, to:, subject:, is:unread, has:attachment, label:/in:, and bare words against subject/text. */
function matches(m: FakeMessageSpec, q: string): boolean {
  const labels = m.labelIds ?? ["INBOX"];
  for (const tok of q.split(/\s+/).filter(Boolean)) {
    const [op, ...rest] = tok.split(":");
    const v = rest.join(":").toLowerCase();
    const hay = `${m.subject} ${m.text ?? ""} ${m.html ?? ""}`.toLowerCase();
    if (rest.length === 0) {
      if (!hay.includes(op!.toLowerCase())) return false;
    } else if (op === "from") {
      if (!m.from.toLowerCase().includes(v)) return false;
    } else if (op === "to") {
      if (!m.to.join(" ").toLowerCase().includes(v)) return false;
    } else if (op === "subject") {
      if (!m.subject.toLowerCase().includes(v)) return false;
    } else if (op === "is" && v === "unread") {
      if (!labels.includes("UNREAD")) return false;
    } else if (op === "has" && v === "attachment") {
      if (!m.attachments?.length) return false;
    } else if (op === "label" || op === "in") {
      if (v !== "anywhere" && !labels.map((l) => l.toLowerCase()).includes(v)) return false;
    }
  }
  return true;
}

let seq = 0;

export function fakeGmail(specs: FakeMailboxSpec[], opts: FakeGmailOpts = {}): FakeGmail {
  const volatile = opts.volatileAttachmentIds ?? false;
  const boxes: Record<string, FakeMessageSpec[]> = Object.fromEntries(specs.map((s) => [s.label, s.messages.map((m) => ({ ...m }))]));
  const labelsOf = new Map(specs.map((s) => [s.label, s.labels ?? DEFAULT_LABELS]));
  const emails = new Map(specs.map((s) => [s.label, s.email]));
  const sent: RawSummary[] = [];
  const drafts: Record<string, RawSummary> = {};
  const log: FakeGmail["log"] = [];

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const label = (new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer tok-/, "");
    const box = boxes[label];
    if (!box) return json({ error: { message: `unknown token for ${label}` } }, 401);
    const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    log.push({ method, path: url.pathname, params: url.searchParams, body, account: label });
    const p = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
    const format = url.searchParams.get("format") ?? "full";
    const mh = url.searchParams.getAll("metadataHeaders");
    const threadOf = (id: string): GmailThread | undefined => {
      const ms = box.filter((m) => m.threadId === id).sort((a, b) => a.date - b.date);
      return ms.length ? { id, snippet: ms[ms.length - 1]!.snippet ?? "", messages: ms.map((m) => toMessage(m, format, mh, volatile)) } : undefined;
    };

    if (p === "/profile") return json({ emailAddress: emails.get(label) });
    if (p === "/labels") return json({ labels: labelsOf.get(label) });

    if (p === "/threads" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const byThread = new Map<string, number>();
      for (const m of box) if (matches(m, q)) byThread.set(m.threadId, Math.max(byThread.get(m.threadId) ?? 0, m.date));
      const ordered = [...byThread.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      const max = Number(url.searchParams.get("maxResults") ?? "100");
      const offset = Number(url.searchParams.get("pageToken") ?? "0");
      const page = ordered.slice(offset, offset + max);
      return json({
        threads: page.map((id) => ({ id, snippet: "" })),
        nextPageToken: offset + max < ordered.length ? String(offset + max) : undefined,
        resultSizeEstimate: ordered.length,
      });
    }

    const threadM = /^\/threads\/([^/]+)(\/modify)?$/.exec(p);
    if (threadM) {
      const id = decodeURIComponent(threadM[1]!);
      const t = threadOf(id);
      if (!t) return json({ error: { message: `Requested entity was not found.` } }, 404);
      if (threadM[2] && method === "POST") {
        const b = body as { addLabelIds?: string[]; removeLabelIds?: string[] };
        for (const m of box) {
          if (m.threadId !== id) continue;
          const set = new Set(m.labelIds ?? ["INBOX"]);
          for (const l of b.removeLabelIds ?? []) set.delete(l);
          for (const l of b.addLabelIds ?? []) set.add(l);
          m.labelIds = [...set];
        }
        return json(threadOf(id));
      }
      return json(t);
    }

    const attM = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(p);
    if (attM && method === "GET") {
      const m = box.find((x) => x.id === decodeURIComponent(attM[1]!));
      const idx = /^att-.*-(\d+)(?:-v(\d+))?$/.exec(decodeURIComponent(attM[2]!));
      const a = m?.attachments?.[Number(idx?.[1] ?? -1)];
      if (!m || !a) return json({ error: { message: "Requested entity was not found." } }, 404);
      if (volatile && Number(idx?.[2] ?? -1) !== latestFetch.get(m.id)) return json({ error: { message: "Requested entity was not found." } }, 404);
      const enc: BufferEncoding = /^(application\/pdf|image\/|application\/octet-stream)/.test(a.mimeType) ? "latin1" : "utf8";
      return json({ size: a.content !== undefined ? Buffer.byteLength(a.content, enc) : a.size, data: b64url(a.content ?? "", enc) });
    }

    const msgM = /^\/messages\/([^/]+)(\/modify)?$/.exec(p);
    if (msgM && msgM[1] !== "send") {
      const id = decodeURIComponent(msgM[1]!);
      const m = box.find((x) => x.id === id);
      if (!m) return json({ error: { message: `Requested entity was not found.` } }, 404);
      if (msgM[2] && method === "POST") {
        const b = body as { addLabelIds?: string[]; removeLabelIds?: string[] };
        const set = new Set(m.labelIds ?? ["INBOX"]);
        for (const l of b.removeLabelIds ?? []) set.delete(l);
        for (const l of b.addLabelIds ?? []) set.add(l);
        m.labelIds = [...set];
      }
      return json(toMessage(m, format, mh, volatile));
    }

    const record = (raw: string, threadId: string | undefined, labelIds: string[]) => {
      const summary = { ...parseRaw(raw), threadId };
      const id = `m${++seq}`;
      const tid = threadId ?? `t${id}`;
      box.push({
        id,
        threadId: tid,
        date: Date.now(),
        from: summary.headers.from ?? "",
        to: (summary.headers.to ?? "").split(/,\s*/).filter(Boolean),
        subject: summary.headers.subject ?? "",
        text: summary.text,
        labelIds,
        rfcMessageId: `<${id}@mail.gmail.com>`,
      });
      return { summary, message: { id, threadId: tid, labelIds } };
    };

    if (p === "/messages/send" && method === "POST") {
      const b = body as { raw: string; threadId?: string };
      const { summary, message } = record(b.raw, b.threadId, ["SENT"]);
      sent.push(summary);
      return json(message);
    }
    if (p === "/drafts" && method === "POST") {
      const b = body as { message: { raw: string; threadId?: string } };
      const { summary, message } = record(b.message.raw, b.message.threadId, ["DRAFT"]);
      const id = `d${seq}`;
      drafts[id] = summary;
      return json({ id, message });
    }
    const draftGet = /^\/drafts\/([^/]+)$/.exec(p);
    if (draftGet && method === "GET" && draftGet[1] !== "send") {
      const d = drafts[decodeURIComponent(draftGet[1]!)];
      if (!d) return json({ error: { message: "Requested entity was not found." } }, 404);
      const headers = Object.entries(d.headers).map(([name, value]) => ({ name, value }));
      return json({ id: draftGet[1], message: { id: `dm-${draftGet[1]}`, threadId: d.threadId ?? "", payload: { headers } } });
    }
    if (p === "/drafts/send" && method === "POST") {
      const b = body as { id: string };
      const d = drafts[b.id];
      if (!d) return json({ error: { message: "Requested entity was not found." } }, 404);
      delete drafts[b.id];
      sent.push(d);
      const draftMsg = box.find((m) => (m.labelIds ?? []).includes("DRAFT") && m.subject === (d.headers.subject ?? ""));
      if (draftMsg) draftMsg.labelIds = ["SENT"];
      return json({ id: draftMsg?.id ?? `m${++seq}`, threadId: draftMsg?.threadId ?? d.threadId ?? `t${seq}`, labelIds: ["SENT"] });
    }
    return json({ error: { message: `unexpected ${method} ${p}` } }, 500);
  };

  return { fetchImpl: fetchImpl as typeof fetch, sent, drafts, log, boxes };
}
