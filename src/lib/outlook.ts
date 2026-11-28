/**
 * Outlook mail (Microsoft Graph v1.0) behind the same surface as GmailClient,
 * so mail.ts and tools-mail.ts serve Gmail and Outlook accounts with one code
 * path. Graph resources are translated into Gmail's shapes:
 *
 * - thread = Graph `conversationId`; ids are requested as immutable ids
 *   (`Prefer: IdType="ImmutableId"`) so they survive moves between folders;
 * - labels: INBOX, SENT, DRAFT, SPAM and TRASH from the message's folder,
 *   UNREAD from `isRead`, STARRED from the follow-up flag, and every other
 *   label is an Outlook category (its name is its id);
 * - removing INBOX moves to Archive, adding TRASH moves to Deleted Items
 *   (restorable). There is no permanent delete here, like gmail.ts;
 * - drafts are messages: draftId = message id; mail is built as MIME by
 *   mime.ts, uploaded as a draft and sent with `messages/{id}/send`.
 */
import type { GmailDraft, GmailHeader, GmailLabel, GmailMessage, GmailPart, GmailThread, MessageFormat } from "./gmail";
import { base64Url, decodeBase64Url } from "./mime";
import { fetchWithRetry, isIdempotentMethod } from "./retry";

export type FetchLike = typeof fetch;

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class OutlookError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

interface Recipient {
  emailAddress?: { name?: string; address?: string };
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  subject?: string | null;
  from?: Recipient | null;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  bccRecipients?: Recipient[];
  replyTo?: Recipient[];
  receivedDateTime?: string;
  sentDateTime?: string | null;
  isRead?: boolean;
  isDraft?: boolean;
  parentFolderId?: string;
  categories?: string[];
  flag?: { flagStatus?: string };
  hasAttachments?: boolean;
  bodyPreview?: string;
  internetMessageId?: string;
  internetMessageHeaders?: GmailHeader[];
  body?: { contentType?: string; content?: string };
}

interface GraphAttachment {
  "@odata.type"?: string;
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  contentBytes?: string;
}

const META_SELECT = [
  "id",
  "conversationId",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "replyTo",
  "receivedDateTime",
  "sentDateTime",
  "isRead",
  "isDraft",
  "parentFolderId",
  "categories",
  "flag",
  "hasAttachments",
  "bodyPreview",
  "internetMessageId",
].join(",");

/** System labels and the well-known folder each one stands for (UNREAD and STARRED are message properties). */
const FOLDER_LABELS = { INBOX: "inbox", SENT: "sentitems", DRAFT: "drafts", SPAM: "junkemail", TRASH: "deleteditems" } as const;
type FolderLabel = keyof typeof FOLDER_LABELS;
const SYSTEM_LABELS = [...Object.keys(FOLDER_LABELS), "UNREAD", "STARRED"];

function fmtRecipient(r: Recipient | null | undefined): string {
  const addr = r?.emailAddress?.address ?? "";
  const name = r?.emailAddress?.name?.trim();
  if (!name || name.toLowerCase() === addr.toLowerCase()) return addr;
  return /[",<>@;:]/.test(name) ? `"${name.replace(/"/g, "'")}" <${addr}>` : `${name} <${addr}>`;
}

function fmtList(rs: Recipient[] | undefined): string | undefined {
  const s = (rs ?? []).map(fmtRecipient).filter(Boolean).join(", ");
  return s || undefined;
}

/**
 * Gmail search operators that have a KQL counterpart are rewritten; is:unread / is:read cannot be combined with
 * Graph's $search and are applied to the returned page instead. Everything else passes through as KQL
 * (from:, to:, subject:, received>=2026-01-01, ...).
 */
export function toKql(query: string, now = Date.now()): { kql: string; unread?: boolean } {
  let unread: boolean | undefined;
  const day = (n: number) => new Date(now - n * 86_400_000).toISOString().slice(0, 10);
  const kql = query
    .replace(/\bis:(unread|read)\b/gi, (_m, v: string) => {
      unread = v.toLowerCase() === "unread";
      return "";
    })
    .replace(/\bhas:attachments?\b/gi, "hasattachments:true")
    .replace(/\bnewer_than:(\d+)d\b/gi, (_m, n: string) => `received>=${day(Number(n))}`)
    .replace(/\bolder_than:(\d+)d\b/gi, (_m, n: string) => `received<${day(Number(n))}`)
    .replace(/\b(in|label):(inbox|anywhere)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return { kql, unread };
}

export class OutlookClient {
  private folders?: Promise<Map<string, FolderLabel>>;

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly base = `${GRAPH_BASE}/me`,
  ) {}

  private async request(pathOrUrl: string, init: RequestInit = {}, noRetry = false): Promise<Response> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    headers.set("Prefer", 'IdType="ImmutableId", outlook.body-content-type="text"');
    const res = await fetchWithRetry(this.fetchImpl, url, { ...init, headers }, { idempotent: isIdempotentMethod(init.method), noRetry });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } };
        detail = body.error?.message ?? body.error?.code ?? "";
      } catch {
        /* ignore */
      }
      const hint = res.status === 403 ? " (is Outlook mail granted? reconnect the account on /connect)" : "";
      throw new OutlookError(`Outlook API ${res.status}${detail ? `: ${detail}` : ""}${hint}`, res.status);
    }
    return res;
  }

  private async json<T>(pathOrUrl: string, init: RequestInit = {}, noRetry = false): Promise<T> {
    return (await this.request(pathOrUrl, init, noRetry)).json() as Promise<T>;
  }

  private patch<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  /** Folder id -> system label for the well-known folders (one lookup per client, i.e. per request). */
  private folderMap(): Promise<Map<string, FolderLabel>> {
    this.folders ??= Promise.all(
      (Object.entries(FOLDER_LABELS) as [FolderLabel, string][]).map(async ([labelId, wk]) => {
        try {
          const f = await this.json<{ id: string }>(`/mailFolders/${wk}?$select=id`);
          return [f.id, labelId] as const;
        } catch {
          return undefined;
        }
      }),
    ).then((pairs) => new Map(pairs.filter((p): p is readonly [string, FolderLabel] => !!p)));
    return this.folders;
  }

  private async toGmail(m: GraphMessage, attachments?: GraphAttachment[]): Promise<GmailMessage> {
    const folders = await this.folderMap();
    const labelIds: string[] = [];
    const folder = m.parentFolderId ? folders.get(m.parentFolderId) : undefined;
    if (folder) labelIds.push(folder);
    else if (m.isDraft) labelIds.push("DRAFT");
    if (m.isRead === false) labelIds.push("UNREAD");
    if (m.flag?.flagStatus === "flagged") labelIds.push("STARRED");
    labelIds.push(...(m.categories ?? []));
    const date = m.sentDateTime ?? m.receivedDateTime;
    const headers: GmailHeader[] = [];
    const add = (name: string, value: string | undefined | null) => void (value ? headers.push({ name, value }) : undefined);
    add("From", m.from ? fmtRecipient(m.from) : undefined);
    add("To", fmtList(m.toRecipients));
    add("Cc", fmtList(m.ccRecipients));
    add("Bcc", fmtList(m.bccRecipients));
    add("Reply-To", fmtList(m.replyTo));
    add("Subject", m.subject ?? "");
    add("Date", date ? new Date(date).toUTCString() : undefined);
    add("Message-ID", m.internetMessageId);
    add("References", m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === "references")?.value);
    add("Content-Type", m.hasAttachments ? "multipart/mixed" : "multipart/alternative");
    const parts: GmailPart[] = [];
    if (m.body?.content) {
      const text = m.body.contentType === "html" ? "text/html" : "text/plain";
      parts.push({ partId: "0", mimeType: text, body: { data: base64Url(Buffer.from(m.body.content, "utf8")) } });
    }
    for (const a of attachments ?? []) {
      parts.push({ partId: a.id, mimeType: a.contentType ?? "application/octet-stream", filename: a.name || "attachment", body: { attachmentId: a.id, size: a.size ?? 0 } });
    }
    const ms = date ? Date.parse(date) : NaN;
    return {
      id: m.id,
      threadId: m.conversationId ?? m.id,
      labelIds,
      snippet: m.bodyPreview ?? "",
      internalDate: Number.isFinite(ms) ? String(ms) : undefined,
      payload: { mimeType: headers.find((h) => h.name === "Content-Type")!.value, headers, parts },
    };
  }

  private async graphMessage(id: string, format: MessageFormat): Promise<GraphMessage> {
    const select = format === "minimal" ? "id,conversationId,parentFolderId,isRead,isDraft,flag,categories" : `${META_SELECT},internetMessageHeaders${format === "full" ? ",body" : ""}`;
    return this.json<GraphMessage>(`/messages/${encodeURIComponent(id)}?$select=${select}`);
  }

  private async attachmentsOf(m: GraphMessage): Promise<GraphAttachment[]> {
    if (!m.hasAttachments) return [];
    const r = await this.json<{ value?: GraphAttachment[] }>(`/messages/${encodeURIComponent(m.id)}/attachments?$select=id,name,contentType,size`);
    return r.value ?? [];
  }

  async listThreads(opts: { q: string; maxResults: number; pageToken?: string }): Promise<{ threads?: { id: string; snippet?: string }[]; nextPageToken?: string; resultSizeEstimate?: number }> {
    const top = Math.min(Math.max(opts.maxResults, 1), 100);
    const { kql, unread } = toKql(opts.q);
    let url: string;
    if (opts.pageToken) {
      if (!opts.pageToken.startsWith(`${this.base}/messages?`)) throw new Error("Invalid pageToken");
      url = opts.pageToken;
    } else {
      const q = new URLSearchParams({ $top: String(top), $select: "id,conversationId,bodyPreview,isRead" });
      if (kql) q.set("$search", `"${kql.replace(/"/g, "'")}"`);
      else {
        q.set("$orderby", "receivedDateTime desc");
        if (unread !== undefined) q.set("$filter", `isRead eq ${!unread}`);
      }
      url = `${this.base}/messages?${q}`;
    }
    const page = await this.json<{ value?: GraphMessage[]; "@odata.nextLink"?: string }>(url);
    const seen = new Set<string>();
    const threads: { id: string; snippet?: string }[] = [];
    for (const m of page.value ?? []) {
      if (kql && unread !== undefined && m.isRead === unread) continue;
      const id = m.conversationId ?? m.id;
      if (seen.has(id)) continue;
      seen.add(id);
      threads.push({ id, snippet: m.bodyPreview });
    }
    return { threads, nextPageToken: page["@odata.nextLink"], resultSizeEstimate: threads.length };
  }

  private async conversation(id: string, format: MessageFormat): Promise<GraphMessage[]> {
    const select = format === "minimal" ? "id,conversationId,parentFolderId,isRead,isDraft,flag,categories" : `${META_SELECT},internetMessageHeaders${format === "full" ? ",body" : ""}`;
    const q = new URLSearchParams({ $filter: `conversationId eq '${id.replace(/'/g, "''")}'`, $select: select, $top: "100" });
    const r = await this.json<{ value?: GraphMessage[] }>(`/messages?${q}`);
    const ms = r.value ?? [];
    if (ms.length === 0) throw new OutlookError(`Outlook API 404: no conversation ${id}`, 404);
    return ms;
  }

  async getThread(id: string, format: MessageFormat): Promise<GmailThread> {
    const ms = await this.conversation(id, format);
    const messages = await Promise.all(ms.map(async (m) => this.toGmail(m, format === "full" ? await this.attachmentsOf(m) : undefined)));
    messages.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));
    return { id, messages };
  }

  async getMessage(id: string, format: MessageFormat): Promise<GmailMessage> {
    const m = await this.graphMessage(id, format);
    return this.toGmail(m, format === "full" ? await this.attachmentsOf(m) : undefined);
  }

  /** Bytes of a file attachment, base64url like Gmail's attachments.get. */
  async getAttachment(messageId: string, attachmentId: string): Promise<{ size?: number; data: string }> {
    const a = await this.json<GraphAttachment>(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    if (a.contentBytes === undefined) throw new Error(`Attachment ${a.name ?? attachmentId} is an attached item or link, not a file; open it in Outlook`);
    const bytes = Buffer.from(a.contentBytes, "base64");
    return { size: bytes.length, data: base64Url(bytes) };
  }

  async listLabels(): Promise<GmailLabel[]> {
    const inbox = await this.json<{ totalItemCount?: number; unreadItemCount?: number }>("/mailFolders/inbox?$select=totalItemCount,unreadItemCount").catch(() => undefined);
    const system: GmailLabel[] = SYSTEM_LABELS.map((id) => ({ id, name: id, type: "system" as const }));
    const inboxLabel = system[0]!;
    inboxLabel.messagesTotal = inbox?.totalItemCount;
    inboxLabel.messagesUnread = inbox?.unreadItemCount;
    const cats = await this.json<{ value?: { displayName: string }[] }>("/outlook/masterCategories").catch(() => ({ value: [] }));
    return [...system, ...(cats.value ?? []).map((c) => ({ id: c.displayName, name: c.displayName, type: "user" as const }))];
  }

  /** `raw` is the base64url RFC 2822 message (mime.ts). Graph files it in Drafts; Outlook threads it by its headers, so `threadId` is not needed. */
  async createDraft(raw: string): Promise<GmailDraft> {
    const mime = Buffer.from(decodeBase64Url(raw)).toString("base64");
    const m = await this.json<GraphMessage>("/messages", { method: "POST", headers: { "Content-Type": "text/plain" }, body: mime }, true);
    return { id: m.id, message: { id: m.id, threadId: m.conversationId ?? m.id, labelIds: ["DRAFT"] } };
  }

  async getDraft(draftId: string): Promise<{ id: string; message: GmailMessage }> {
    const m = await this.graphMessage(draftId, "metadata");
    if (!m.isDraft) throw new Error(`${draftId} is not a draft`);
    return { id: draftId, message: await this.toGmail(m) };
  }

  /** Send a draft. The sent copy in Sent Items gets a new id; it is looked up by Message-ID (falls back to the draft id). */
  async sendDraft(draftId: string): Promise<GmailMessage> {
    const d = await this.json<GraphMessage>(`/messages/${encodeURIComponent(draftId)}?$select=id,conversationId,isDraft,internetMessageId`);
    if (!d.isDraft) throw new Error(`${draftId} is not a draft`);
    await this.request(`/messages/${encodeURIComponent(draftId)}/send`, { method: "POST" }, true);
    let id = draftId;
    if (d.internetMessageId) {
      const q = new URLSearchParams({ $filter: `internetMessageId eq '${d.internetMessageId.replace(/'/g, "''")}'`, $select: "id,conversationId", $top: "1" });
      const hit = await this.json<{ value?: GraphMessage[] }>(`/mailFolders/sentitems/messages?${q}`).catch(() => undefined);
      if (hit?.value?.[0]) id = hit.value[0].id;
    }
    return { id, threadId: d.conversationId ?? draftId, labelIds: ["SENT"] };
  }

  /** Graph has no one-shot MIME send that returns ids, so: create the draft, then send it. */
  async sendMessage(raw: string): Promise<GmailMessage> {
    const draft = await this.createDraft(raw);
    return this.sendDraft(draft.id);
  }

  private async applyLabels(m: GraphMessage, add: string[], remove: string[]): Promise<void> {
    for (const l of [...add, ...remove]) if (l === "SENT" || l === "DRAFT") throw new Error(`${l} cannot be added or removed on Outlook`);
    const folders = await this.folderMap();
    const current = m.parentFolderId ? folders.get(m.parentFolderId) : undefined;
    const patch: Record<string, unknown> = {};
    if (add.includes("UNREAD")) patch.isRead = false;
    if (remove.includes("UNREAD")) patch.isRead = true;
    if (add.includes("STARRED")) patch.flag = { flagStatus: "flagged" };
    if (remove.includes("STARRED")) patch.flag = { flagStatus: "notFlagged" };
    const addCats = add.filter((l) => !SYSTEM_LABELS.includes(l));
    const removeCats = remove.filter((l) => !SYSTEM_LABELS.includes(l));
    if (addCats.length || removeCats.length) {
      patch.categories = [...new Set([...(m.categories ?? []), ...addCats])].filter((c) => !removeCats.includes(c));
    }
    if (Object.keys(patch).length) await this.patch(`/messages/${encodeURIComponent(m.id)}`, patch);

    let dest: string | undefined;
    if (add.includes("TRASH")) dest = "deleteditems";
    else if (add.includes("SPAM")) dest = "junkemail";
    else if (add.includes("INBOX")) dest = current === "SENT" || current === "DRAFT" || current === "INBOX" ? undefined : "inbox";
    else if ((remove.includes("TRASH") && current === "TRASH") || (remove.includes("SPAM") && current === "SPAM")) dest = "inbox";
    else if (remove.includes("INBOX") && current === "INBOX") dest = "archive";
    if (dest && FOLDER_LABELS[current as FolderLabel] !== dest) {
      await this.json(`/messages/${encodeURIComponent(m.id)}/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationId: dest }) });
    }
  }

  async modifyMessage(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<GmailMessage> {
    await this.applyLabels(await this.graphMessage(id, "minimal"), addLabelIds, removeLabelIds);
    return this.getMessage(id, "minimal");
  }

  async modifyThread(id: string, addLabelIds: string[], removeLabelIds: string[]): Promise<GmailThread> {
    for (const m of await this.conversation(id, "minimal")) await this.applyLabels(m, addLabelIds, removeLabelIds);
    return this.getThread(id, "minimal");
  }
}

const CONSUMER_DOMAINS = /@(outlook|hotmail|live|msn|passport)\.[a-z.]+$/i;

/** Outlook on the web for this mailbox (consumer or Microsoft 365). */
export function outlookWebLink(email: string, folder: "all" | "drafts" = "all"): string {
  const base = CONSUMER_DOMAINS.test(email) ? "https://outlook.live.com/mail/0/" : "https://outlook.office.com/mail/";
  return folder === "drafts" ? `${base}drafts` : base;
}
