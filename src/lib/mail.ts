/**
 * The operations behind the mail_* tools: per-account Gmail context with the
 * scope gate, message composition (Drive attachments, reply headers), reply
 * recipient logic and label changes. Tool handlers in tools-mail.ts stay thin.
 */
import { assertAccountWritable, assertMailAllowed, type MailNeed } from "./access";
import { appendAudit, type AuditEntry } from "./audit";
import { baseUrl } from "./config";
import { assertWritable, checkName, ctxFor, currentDriveFetch, ownerLabel, resolvePutTarget, toResult, type FileResult } from "./ctx";
import { FOLDER_MIME } from "./drive";
import { extractEmail, GmailClient, header, latestMessage, parseAddressList, parseMessage, type AttachmentInfo, type FetchLike } from "./gmail";
import { base64Url, buildMime, decodeBase64Url, renderHtml, type MimeAttachment } from "./mime";
import { isGoogleNativeMime } from "./naming";
import { assertGoogleAccount } from "./providers/guards";
import { MAX_READ_BYTES, NoTextError, paginate, pickReader, readContent } from "./readers";
import { accessTokenFor, getAccount, gmailGranted, type Account } from "./store";
import { uploadBytes } from "./upload";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Google-native types that can be exported to PDF for attaching. */
const PDF_EXPORTABLE = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
]);

let mailFetch: FetchLike | undefined;

/** Test seam: route every GmailClient through this fetch. */
export function setMailFetch(f: FetchLike | undefined) {
  mailFetch = f;
}

export interface MailCtx {
  account: Account;
  gmail: GmailClient;
  /** Lower-cased address of the connected account; used as the sender and to exclude oneself from reply-all. */
  email: string;
}

export function gmailNotGranted(label: string): Error {
  return new Error(`Gmail not granted for ${label}; open ${baseUrl()}/connect and grant Gmail access`);
}

/**
 * Gmail context for `label`. `need` is checked against the account's mode and
 * mail setting before any Gmail call (read-only accounts cannot draft, send or
 * relabel; mail "off" blocks everything; mail "draft" blocks sending).
 */
export async function mailCtxFor(label: string, need: MailNeed = "read"): Promise<MailCtx> {
  const account = await getAccount(label);
  assertGoogleAccount(account);
  assertMailAllowed(account, need);
  if (!gmailGranted(account)) throw gmailNotGranted(label);
  const gmail = new GmailClient(await accessTokenFor(account), mailFetch ?? fetch);
  return { account, gmail, email: account.email.toLowerCase() };
}

export function gmailWebLink(email: string, threadId: string | undefined, folder: "all" | "drafts" = "all"): string {
  const base = `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}`;
  return threadId ? `${base}#${folder}/${threadId}` : `${base}#${folder}`;
}

// ---- attachments -------------------------------------------------------------

export interface AttachmentRef {
  driveFileId: string;
  /** Account that holds the file; defaults to the sending account. */
  account?: string;
}

export interface AttachmentSummary {
  driveFileId: string;
  account: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** Download each Drive file through its owning account's token; Google-native files are exported to PDF. Total capped at MAX_ATTACHMENT_BYTES. */
export async function loadAttachments(refs: AttachmentRef[] | undefined, defaultAccount: string): Promise<{ parts: MimeAttachment[]; summary: AttachmentSummary[] }> {
  const parts: MimeAttachment[] = [];
  const summary: AttachmentSummary[] = [];
  let total = 0;
  for (const ref of refs ?? []) {
    const label = ref.account ?? defaultAccount;
    const c = await ctxFor(label);
    const meta = await c.drive.getFile(ref.driveFileId);
    if (meta.mimeType === FOLDER_MIME) throw new Error(`Cannot attach a folder (${meta.name}); attach files`);
    let exportMime: string | undefined;
    let filename = meta.name;
    if (isGoogleNativeMime(meta.mimeType)) {
      if (!PDF_EXPORTABLE.has(meta.mimeType)) throw new Error(`Cannot attach ${meta.name}: Google type ${meta.mimeType} has no PDF export`);
      exportMime = "application/pdf";
      filename = /\.pdf$/i.test(filename) ? filename : `${filename}.pdf`;
    } else if (meta.size && Number(meta.size) + total > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachments exceed ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB in total (${meta.name} is ${meta.size} bytes)`);
    }
    const { bytes, contentType } = await c.drive.download(meta.id, exportMime);
    total += bytes.length;
    if (total > MAX_ATTACHMENT_BYTES) throw new Error(`Attachments exceed ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB in total (after ${meta.name})`);
    const mimeType = exportMime ?? (meta.mimeType && meta.mimeType !== "application/octet-stream" ? meta.mimeType : contentType.split(";")[0]!.trim());
    parts.push({ filename, mimeType, bytes: new Uint8Array(bytes) });
    summary.push({ driveFileId: meta.id, account: label, filename, mimeType, size: bytes.length });
  }
  return { parts, summary };
}

// ---- incoming attachments ----------------------------------------------------

export interface AttachmentSelector {
  /** Stable: MIME part id from mail_read. */
  partId?: string;
  /** Stable: position from mail_read (0-based). */
  index?: number;
  /** Stable when unique within the message. */
  filename?: string;
  /** Volatile: only honoured when Gmail still reports it; with a single attachment it falls back to that one. */
  attachmentId?: string;
}

/**
 * Metadata of one attachment of a message, freshly fetched. Gmail changes
 * `attachmentId` between `messages.get` calls, so the selection is made by
 * partId, index or filename and the attachmentId returned here is the fresh
 * one to use with attachments.get right away.
 */
export async function attachmentInfo(c: MailCtx, messageId: string, sel: AttachmentSelector): Promise<AttachmentInfo> {
  const m = parseMessage(await c.gmail.getMessage(messageId, "full"), 0);
  const all = m.attachments;
  const describe = () => all.map((x) => `#${x.index} ${x.filename} (partId ${x.partId ?? "?"})`).join(", ") || "none";
  const fail = (what: string) => new Error(`Message ${messageId} has no attachment ${what}. Attachments: ${describe()}. Select by partId, index or filename (attachmentId is not stable across reads).`);
  if (sel.partId !== undefined) {
    const hit = all.find((x) => x.partId === sel.partId);
    if (!hit) throw fail(`with partId ${sel.partId}`);
    return hit;
  }
  if (sel.index !== undefined) {
    const hit = all[sel.index];
    if (!hit) throw fail(`#${sel.index}`);
    return hit;
  }
  if (sel.filename !== undefined) {
    const hits = all.filter((x) => x.filename === sel.filename);
    if (hits.length === 1) return hits[0]!;
    if (hits.length > 1) throw new Error(`Message ${messageId} has ${hits.length} attachments named ${sel.filename}; select by index or partId. Attachments: ${describe()}`);
    throw fail(`named ${sel.filename}`);
  }
  if (sel.attachmentId !== undefined) {
    const hit = all.find((x) => x.attachmentId === sel.attachmentId) ?? all.find((x) => x.filename === sel.attachmentId);
    if (hit) return hit;
    if (all.length === 1) return all[0]!;
    throw fail(`${sel.attachmentId}`);
  }
  throw new Error(`Give partId, index or filename to pick an attachment. Attachments: ${describe()}`);
}

/** Download the bytes of an attachment part (Gmail serves them base64url-encoded). */
export async function downloadAttachment(c: MailCtx, messageId: string, info: AttachmentInfo): Promise<Buffer> {
  if (!info.attachmentId) throw new Error(`Attachment ${info.filename} has no attachmentId (inline part); nothing to download`);
  const r = await c.gmail.getAttachment(messageId, info.attachmentId);
  return Buffer.from(decodeBase64Url(r.data));
}

export interface SaveTarget {
  account: string;
  path?: string;
  folderId?: string;
  /** Name for the Drive file (default: the attachment's filename). */
  name?: string;
  /** Prepended as `<prefix>_<filename>` when `name` is not given, e.g. "2026-11-01_Acme" to satisfy the naming rule in bulk. */
  prefix?: string;
  allowNonStandardName?: boolean;
}

/** Final Drive name for an attachment: explicit name, else prefix_filename, else the filename. */
export function attachmentDriveName(filename: string, t: Pick<SaveTarget, "name" | "prefix">): string {
  if (t.name) return t.name;
  return t.prefix ? `${t.prefix}_${filename}` : filename;
}

/** Upload attachment bytes into a Drive folder of `saveTo.account` (multipart up to 5 MB, else a resumable session). Audit-logged. */
export async function saveAttachment(c: MailCtx, messageId: string, info: AttachmentInfo, bytes: Buffer, saveTo: SaveTarget, actor: string): Promise<FileResult> {
  const name = attachmentDriveName(info.filename, saveTo);
  checkName(name, undefined, saveTo.allowNonStandardName ?? false);
  const d = await ctxFor(saveTo.account);
  assertAccountWritable(d.account);
  const folderId = await resolvePutTarget(d.drive, { path: saveTo.path, folderId: saveTo.folderId }, d.rootId);
  assertWritable(await d.drive.getFile(folderId), "addChildren");
  const file = await uploadBytes(d.drive, currentDriveFetch(), { name, parents: [folderId] }, new Uint8Array(bytes), info.mimeType || "application/octet-stream");
  await appendAudit({
    tool: "mail_attachment",
    account: c.account.label,
    toAccount: saveTo.account,
    fileId: file.id,
    name: file.name,
    to: folderId,
    owner: ownerLabel(d, file),
    actor,
    messageId,
    attachments: [info.filename],
    size: bytes.length,
  });
  return toResult(d, file);
}

export interface AttachmentText {
  text: string | null;
  offset?: number;
  nextOffset?: number;
  totalChars?: number;
  truncated?: boolean;
  note?: string;
}

/** Text of an attachment via the `read` readers (pdf/docx/xlsx/csv/txt); other types (images, zips, ...) get metadata only. */
export async function attachmentText(info: AttachmentInfo, bytes: Buffer, maxChars: number, offset = 0): Promise<AttachmentText> {
  const kind = pickReader(info.mimeType, info.filename);
  if (kind === "none") return { text: null, note: `No text reader for ${info.mimeType || "this type"}; metadata only. Use saveTo to store the file in Drive.` };
  if (bytes.length > MAX_READ_BYTES) return { text: null, note: `Attachment exceeds ${MAX_READ_BYTES / (1024 * 1024)} MB; use saveTo to store it in Drive.` };
  try {
    const full = await readContent(kind, bytes, {});
    return paginate(full, offset, maxChars);
  } catch (e) {
    if (e instanceof NoTextError) return { text: null, note: `${e.message} Use saveTo to store the file in Drive.` };
    throw e;
  }
}

// ---- composing ---------------------------------------------------------------

export interface ComposeArgs {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Reply to this message: sets In-Reply-To/References and the thread. */
  replyToMessageId?: string;
  attachments?: AttachmentRef[];
}

export interface Composed {
  raw: string;
  threadId?: string;
  attachments: AttachmentSummary[];
  recipients: string[];
}

export async function compose(c: MailCtx, a: ComposeArgs): Promise<Composed> {
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadId: string | undefined;
  if (a.replyToMessageId) {
    const orig = await c.gmail.getMessage(a.replyToMessageId, "metadata");
    inReplyTo = header(orig.payload, "Message-ID");
    references = [header(orig.payload, "References"), inReplyTo].filter(Boolean).join(" ") || undefined;
    threadId = orig.threadId;
  }
  const { parts, summary } = await loadAttachments(a.attachments, c.account.label);
  const raw = base64Url(
    buildMime({
      from: c.email,
      to: a.to,
      cc: a.cc,
      bcc: a.bcc,
      subject: a.subject,
      text: a.body,
      html: renderHtml(a.body),
      inReplyTo,
      references,
      attachments: parts,
    }),
  );
  return { raw, threadId, attachments: summary, recipients: [...a.to, ...(a.cc ?? []), ...(a.bcc ?? [])] };
}

// ---- replying ----------------------------------------------------------------

export interface ReplyTarget {
  replyToMessageId: string;
  to: string[];
  cc: string[];
  subject: string;
}

/** Recipients and subject for a reply to the newest message of `threadId`. */
export async function replyTarget(c: MailCtx, threadId: string, replyAll: boolean): Promise<ReplyTarget> {
  const thread = await c.gmail.getThread(threadId, "metadata");
  const latest = latestMessage(thread);
  if (!latest) throw new Error(`Thread ${threadId} has no messages`);
  const from = header(latest.payload, "From") ?? "";
  const replyTo = header(latest.payload, "Reply-To");
  const origTo = parseAddressList(header(latest.payload, "To"));
  const origCc = parseAddressList(header(latest.payload, "Cc"));
  const fromMe = extractEmail(from) === c.email;

  // Replying to your own last message continues to the people you wrote to.
  const to = fromMe ? origTo : [replyTo ?? from];
  const seen = new Set<string>([c.email, ...to.map(extractEmail)]);
  const cc: string[] = [];
  if (replyAll) {
    for (const addr of [...(fromMe ? [] : origTo), ...origCc]) {
      const e = extractEmail(addr);
      if (seen.has(e)) continue;
      seen.add(e);
      cc.push(addr);
    }
  }
  const subject = header(latest.payload, "Subject") ?? "";
  return { replyToMessageId: latest.id, to, cc, subject: /^\s*re:/i.test(subject) ? subject : `Re: ${subject}` };
}

// ---- labels ------------------------------------------------------------------

/** Map label names (case-insensitive) or ids to ids; unknown names are an error listing what exists. */
export async function resolveLabelIds(c: MailCtx, given: string[]): Promise<string[]> {
  if (given.length === 0) return [];
  const labels = await c.gmail.listLabels();
  return given.map((g) => {
    const hit = labels.find((l) => l.id === g) ?? labels.find((l) => l.name.toLowerCase() === g.toLowerCase());
    if (!hit) throw new Error(`Unknown label "${g}". Labels: ${labels.map((l) => l.name).join(", ")}`);
    return hit.id;
  });
}

export interface LabelChangeArgs {
  messageId?: string;
  threadId?: string;
  add?: string[];
  remove?: string[];
  markRead?: boolean;
}

export async function changeLabels(c: MailCtx, a: LabelChangeArgs & { dryRun?: boolean }, actor: string) {
  if (!a.messageId === !a.threadId) throw new Error("Give exactly one of messageId or threadId");
  const add = await resolveLabelIds(c, a.add ?? []);
  const remove = await resolveLabelIds(c, a.remove ?? []);
  if (a.markRead === true && !remove.includes("UNREAD")) remove.push("UNREAD");
  if (a.markRead === false && !add.includes("UNREAD")) add.push("UNREAD");
  if (add.length === 0 && remove.length === 0) throw new Error("Nothing to change: give add, remove or markRead");
  if (a.dryRun) {
    // Confirm the target exists; change nothing.
    if (a.messageId) await c.gmail.getMessage(a.messageId, "minimal");
    else await c.gmail.getThread(a.threadId!, "minimal");
    return { dryRun: true, account: c.account.label, messageId: a.messageId, threadId: a.threadId, wouldAdd: add, wouldRemove: remove };
  }
  const result = a.messageId ? await c.gmail.modifyMessage(a.messageId, add, remove) : await c.gmail.modifyThread(a.threadId!, add, remove);
  const labels = a.messageId ? ((result as { labelIds?: string[] }).labelIds ?? []) : [...new Set(((result as { messages?: { labelIds?: string[] }[] }).messages ?? []).flatMap((m) => m.labelIds ?? []))];
  await appendAudit({ tool: "mail_label", account: c.account.label, actor, messageId: a.messageId, threadId: a.threadId, add, remove });
  return { account: c.account.label, messageId: a.messageId, threadId: a.threadId, added: add, removed: remove, labels };
}

// ---- audit helper ------------------------------------------------------------

export function mailAudit(c: MailCtx, tool: string, actor: string, composed: Composed, subject: string, ids: Partial<Pick<AuditEntry, "messageId" | "threadId" | "draftId">>) {
  return appendAudit({
    tool,
    account: c.account.label,
    actor,
    recipients: composed.recipients,
    subject,
    attachments: composed.attachments.map((x) => x.filename),
    ...ids,
  });
}
