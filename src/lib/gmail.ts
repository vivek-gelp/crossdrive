/**
 * Minimal Gmail v1 REST client over fetch (same shape as drive.ts: one
 * instance per request, access token from the caller) plus pure parsers that
 * turn Gmail's message resource into the flat shape the mail tools return.
 *
 * There is deliberately no `messages.delete` / `threads.delete` and no
 * `drafts.delete`: trash via the TRASH label is the only removal.
 */
import { decodeBase64Url, htmlToText } from "./mime";
import { fetchWithRetry, isIdempotentMethod } from "./retry";

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  /** Epoch milliseconds as a string. */
  internalDate?: string;
  payload?: GmailPart;
  sizeEstimate?: number;
}

export interface GmailThread {
  id: string;
  snippet?: string;
  messages?: GmailMessage[];
}

export interface GmailLabel {
  id: string;
  name: string;
  type?: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
}

export interface GmailDraft {
  id: string;
  message: { id: string; threadId: string; labelIds?: string[] };
}

export type MessageFormat = "metadata" | "full" | "minimal";

export type FetchLike = typeof fetch;

export class GmailError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Headers requested for list/metadata reads; enough for summaries and reply headers. */
export const SUMMARY_HEADERS = ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID", "References", "In-Reply-To", "Content-Type"];

export class GmailClient {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
    base = "https://gmail.googleapis.com",
  ) {
    this.base = base.replace(/\/$/, "");
  }

  /** `noRetry` for sends: a repeated send could deliver the message twice. */
  private async json<T>(path: string, init: RequestInit = {}, noRetry = false): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    const res = await fetchWithRetry(this.fetchImpl, `${this.base}/gmail/v1/users/me${path}`, { ...init, headers }, { idempotent: isIdempotentMethod(init.method), noRetry });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body.error?.message ?? "";
      } catch {
        /* ignore */
      }
      throw new GmailError(`Gmail API ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
    return res.json() as Promise<T>;
  }

  private post<T>(path: string, body: unknown, noRetry = false): Promise<T> {
    return this.json<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, noRetry);
  }

  profile(): Promise<{ emailAddress: string; messagesTotal?: number; threadsTotal?: number }> {
    return this.json("/profile");
  }

  listThreads(opts: { q: string; maxResults: number; pageToken?: string }): Promise<{ threads?: { id: string; snippet?: string }[]; nextPageToken?: string; resultSizeEstimate?: number }> {
    const q = new URLSearchParams({ q: opts.q, maxResults: String(Math.min(Math.max(opts.maxResults, 1), 100)) });
    if (opts.pageToken) q.set("pageToken", opts.pageToken);
    return this.json(`/threads?${q}`);
  }

  getThread(id: string, format: MessageFormat, metadataHeaders = SUMMARY_HEADERS): Promise<GmailThread> {
    const q = new URLSearchParams({ format });
    if (format === "metadata") for (const h of metadataHeaders) q.append("metadataHeaders", h);
    return this.json(`/threads/${encodeURIComponent(id)}?${q}`);
  }

  getMessage(id: string, format: MessageFormat, metadataHeaders = SUMMARY_HEADERS): Promise<GmailMessage> {
    const q = new URLSearchParams({ format });
    if (format === "metadata") for (const h of metadataHeaders) q.append("metadataHeaders", h);
    return this.json(`/messages/${encodeURIComponent(id)}?${q}`);
  }

  /** `messages.attachments.get`: the body bytes (base64url) of one attachment part. */
  async getAttachment(messageId: string, attachmentId: string): Promise<{ size?: number; data: string }> {
    return this.json(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  }

  async listLabels(): Promise<GmailLabel[]> {
    const r = await this.json<{ labels?: GmailLabel[] }>("/labels");
    return r.labels ?? [];
  }

  /** `raw` is the base64url RFC 2822 message. `threadId` places the draft in an existing thread. */
  createDraft(raw: string, threadId?: string): Promise<GmailDraft> {
    return this.post("/drafts", { message: { raw, ...(threadId ? { threadId } : {}) } });
  }

  /** `drafts.get` (metadata): the draft's headers, used to check recipients before sending it. */
  getDraft(draftId: string): Promise<{ id: string; message: GmailMessage }> {
    const q = new URLSearchParams({ format: "metadata" });
    for (const h of ["To", "Cc", "Bcc", "Subject"]) q.append("metadataHeaders", h);
    return this.json(`/drafts/${encodeURIComponent(draftId)}?${q}`);
  }

  sendDraft(draftId: string): Promise<GmailMessage> {
    return this.post("/drafts/send", { id: draftId }, true);
  }

  sendMessage(raw: string, threadId?: string): Promise<GmailMessage> {
    return this.post("/messages/send", { raw, ...(threadId ? { threadId } : {}) }, true);
  }

  modifyMessage(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<GmailMessage> {
    return this.post(`/messages/${encodeURIComponent(id)}/modify`, { addLabelIds, removeLabelIds });
  }

  modifyThread(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<GmailThread> {
    return this.post(`/threads/${encodeURIComponent(id)}/modify`, { addLabelIds, removeLabelIds });
  }
}

// ---- parsing -----------------------------------------------------------------

export function header(part: GmailPart | undefined, name: string): string | undefined {
  const target = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === target)?.value;
}

/** Split an address header on commas that are outside quotes and angle brackets. */
export function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let depth = 0;
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") depth++;
    else if (!quoted && ch === ">") depth = Math.max(0, depth - 1);
    if (ch === "," && !quoted && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The bare, lower-cased address of `Name <addr>` or `addr`. */
export function extractEmail(addr: string): string {
  const m = /<([^<>\s]+)>/.exec(addr);
  return (m ? m[1]! : addr.trim().replace(/^"|"$/g, "")).toLowerCase();
}

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
  /**
   * Gmail's handle for `messages.attachments.get`. Gmail does NOT keep it stable across `messages.get` calls, so it is
   * only valid together with the fetch that produced it; select attachments by `partId`, `index` or `filename` instead.
   */
  attachmentId?: string;
  /** MIME part id (e.g. "2", "1.2"); stable for the message. */
  partId?: string;
  /** Position among the message's attachments, from 0; stable for the message. */
  index: number;
  /** Message the attachment belongs to (set on thread reads). */
  messageId?: string;
}

export interface ParsedMessage {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  replyTo?: string;
  subject: string;
  /** ISO 8601 from Gmail's internalDate, falling back to the Date header. */
  date: string;
  labels: string[];
  unread: boolean;
  snippet: string;
  /** Plain text body: text/plain when present, else the html part rendered as text. Never raw HTML. */
  body: string;
  bodyTruncated: boolean;
  attachments: AttachmentInfo[];
  /** RFC Message-ID header, for reply threading. */
  rfcMessageId?: string;
  references?: string;
}

function decodeBody(data: string | undefined): string {
  return data ? Buffer.from(decodeBase64Url(data)).toString("utf8") : "";
}

function walk(part: GmailPart, acc: { plain: string[]; html: string[]; attachments: AttachmentInfo[] }, messageId: string) {
  const mime = (part.mimeType ?? "").toLowerCase();
  if (part.filename) {
    acc.attachments.push({
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
      attachmentId: part.body?.attachmentId,
      partId: part.partId,
      index: acc.attachments.length,
      messageId,
    });
    return;
  }
  if (mime === "text/plain" && part.body?.data) acc.plain.push(decodeBody(part.body.data));
  else if (mime === "text/html" && part.body?.data) acc.html.push(decodeBody(part.body.data));
  for (const p of part.parts ?? []) walk(p, acc, messageId);
}

export function isoDate(m: GmailMessage): string {
  const ms = Number(m.internalDate);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  const d = header(m.payload, "Date");
  const parsed = d ? new Date(d) : undefined;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : "";
}

/** Flatten a `format=full` message. `maxChars` caps the body (bodyTruncated=true when cut). */
export function parseMessage(m: GmailMessage, maxChars = Number.POSITIVE_INFINITY): ParsedMessage {
  const acc = { plain: [] as string[], html: [] as string[], attachments: [] as AttachmentInfo[] };
  if (m.payload) walk(m.payload, acc, m.id);
  const full = acc.plain.length ? acc.plain.join("\n\n").trim() : acc.html.length ? htmlToText(acc.html.join("\n")) : "";
  const body = full.length > maxChars ? full.slice(0, maxChars) : full;
  const labels = m.labelIds ?? [];
  return {
    messageId: m.id,
    threadId: m.threadId,
    from: header(m.payload, "From") ?? "",
    to: parseAddressList(header(m.payload, "To")),
    cc: parseAddressList(header(m.payload, "Cc")),
    replyTo: header(m.payload, "Reply-To"),
    subject: header(m.payload, "Subject") ?? "",
    date: isoDate(m),
    labels,
    unread: labels.includes("UNREAD"),
    snippet: m.snippet ?? "",
    body,
    bodyTruncated: body.length < full.length,
    attachments: acc.attachments,
    rfcMessageId: header(m.payload, "Message-ID"),
    references: header(m.payload, "References"),
  };
}

export interface ThreadSummary {
  threadId: string;
  /** Id of the newest message in the thread. */
  messageId: string;
  from: string;
  to: string[];
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  unread: boolean;
  /** Based on the newest message's Content-Type (multipart/mixed); exact attachment metadata comes from mail_read. */
  hasAttachments: boolean;
  messageCount: number;
}

/** Newest message in a thread (Gmail returns messages oldest first; sort defensively). */
export function latestMessage(t: GmailThread): GmailMessage | undefined {
  const ms = [...(t.messages ?? [])].sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
  return ms[ms.length - 1];
}

/** Summary of a `format=metadata` thread for mail_search. */
export function summarizeThread(t: GmailThread): ThreadSummary | undefined {
  const latest = latestMessage(t);
  if (!latest) return undefined;
  const labels = [...new Set((t.messages ?? []).flatMap((m) => m.labelIds ?? []))].sort();
  return {
    threadId: t.id,
    messageId: latest.id,
    from: header(latest.payload, "From") ?? "",
    to: parseAddressList(header(latest.payload, "To")),
    subject: header(latest.payload, "Subject") ?? "",
    date: isoDate(latest),
    snippet: latest.snippet ?? t.snippet ?? "",
    labels,
    unread: labels.includes("UNREAD"),
    hasAttachments: (t.messages ?? []).some((m) => /^multipart\/mixed/i.test(header(m.payload, "Content-Type") ?? "")),
    messageCount: t.messages?.length ?? 0,
  };
}
