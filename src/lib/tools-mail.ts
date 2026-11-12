/**
 * Gmail tools. Read: mail_search, mail_read, mail_labels. Write: mail_draft,
 * mail_send, mail_reply, mail_label. Every tool takes `account` (the sender
 * is never inferred); every write is audit-logged with recipients and
 * subject. Nothing here deletes mail: trash is the TRASH label.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { allowedRecipients, assertRecipientsAllowed } from "./access";
import { parseAddressList, parseMessage, summarizeThread, type AttachmentInfo, type ParsedMessage, type ThreadSummary } from "./gmail";
import {
  attachmentInfo,
  attachmentText,
  changeLabels,
  compose,
  downloadAttachment,
  gmailWebLink,
  mailAudit,
  mailCtxFor,
  MAX_ATTACHMENT_BYTES,
  replyTarget,
  saveAttachment,
  type AttachmentRef,
  type MailCtx,
  type SaveTarget,
} from "./mail";
import { actorOf } from "./oauth";
import { label, wrap } from "./toolkit";
import { inboxFolder } from "./ctx";
import { namingRuleEnabled, NAMING_RULE } from "./naming";
import { UNTRUSTED_NOTICE } from "./untrusted";

const address = z
  .string()
  .trim()
  .refine((v) => /^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(v) || /<[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/.test(v), "must be an e-mail address or Name <address>")
  .describe("E-mail address, optionally as Name <address>");
const addresses = z.array(address).max(100);
const attachments = z
  .array(z.object({ driveFileId: z.string().min(1), account: label.optional().describe("Account that holds the file; default: the sending account") }))
  .max(10)
  .optional()
  .describe(`Drive files to attach (downloaded through the owning account; Docs/Sheets/Slides exported to PDF; total <= ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB)`);

const composeFields = {
  to: addresses.min(1),
  cc: addresses.optional(),
  bcc: addresses.optional(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1).describe("Plain text. Blank lines separate paragraphs; - bullets, [text](url) links, **bold** and bare URLs are also rendered into an HTML part."),
  replyToMessageId: z.string().optional().describe("Reply to this message: sets In-Reply-To/References and puts the mail in its thread"),
  attachments,
};

const MAX_SEARCH = 50;

// Schemas that mention the inbox folder or the naming rule are built at registration time from the active config.
function saveSchemas() {
  const naming = namingRuleEnabled();
  const saveTargetFields = {
    account: label.describe("Account whose Drive receives the file"),
    path: z.string().optional().describe(`Destination folder path in that account (label:/A/B, label:~shared/Top/B or label:drive/<Drive>/B); default ${inboxFolder()}`),
    folderId: z.string().optional().describe("Destination folder id (alternative to path)"),
    allowNonStandardName: z.boolean().default(false).describe(naming ? `Skip the ${NAMING_RULE} rule` : "Only relevant when the server enforces a naming rule"),
  };
  const saveTo = z
    .object({
      ...saveTargetFields,
      name: z.string().min(1).optional().describe(naming ? "Drive file name; default the attachment's filename (must follow the naming rule unless allowNonStandardName)" : "Drive file name; default the attachment's filename"),
    })
    .optional()
    .describe("Store the attachment in Drive instead of returning its text");
  const saveAttachmentsTo = z
    .object({
      ...saveTargetFields,
      prefix: z.string().min(1).optional().describe(naming ? "Saved as <prefix>_<filename>, e.g. 2026-11-01_Acme, so the names follow the naming rule" : "Saved as <prefix>_<filename>"),
    })
    .optional()
    .describe("Save every attachment of the message(s) into this Drive folder and list the created files");
  return { saveTo, saveAttachmentsTo };
}
type SaveSchemas = ReturnType<typeof saveSchemas>;

export interface SavedAttachment {
  messageId: string;
  filename: string;
  status: "saved" | "error";
  file?: unknown;
  error?: string;
}

/** Download and store every attachment of `messages`; one entry per attachment, errors per item instead of aborting. */
async function saveAll(c: MailCtx, messages: ParsedMessage[], target: SaveTarget, actor: string): Promise<SavedAttachment[]> {
  const out: SavedAttachment[] = [];
  for (const m of messages) {
    for (const info of m.attachments) {
      try {
        const bytes = await downloadAttachment(c, m.messageId, info);
        out.push({ messageId: m.messageId, filename: info.filename, status: "saved", file: await saveAttachment(c, m.messageId, info, bytes, target, actor) });
      } catch (e) {
        out.push({ messageId: m.messageId, filename: info.filename, status: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return out;
}

export interface MailReadToolOpts {
  /** Register the saving variants (saveTo / saveAttachmentsTo); false for read-only tokens. */
  allowSave: boolean;
}

/**
 * On a read-only token the saving arguments are not advertised. Every tool schema is strict (strict.ts), so a client
 * that sends them anyway is refused with this same explanation by the argument check; the handlers repeat the check.
 */
export function readOnlySaveRefusal(arg: string): Error {
  return new Error(`${arg} needs a full-access client: this token is read-only, so nothing was saved. Call again without ${arg} to read the content.`);
}

/** mail_read arguments; the read-only server omits saveAttachmentsTo (and refuses it if sent). */
const readShapeFor = ({ saveAttachmentsTo }: SaveSchemas) => {
  const readOnly = {
    account: label,
    messageId: z.string().optional(),
    threadId: z.string().optional(),
    maxChars: z.number().int().min(100).max(200_000).default(20_000).describe("Body cap per message"),
  };
  return { readOnly, full: { ...readOnly, saveAttachmentsTo } };
};

export function registerMailReadTools(server: McpServer, opts: MailReadToolOpts = { allowSave: false }) {
  const schemas = saveSchemas();
  const { saveTo } = schemas;
  const readShape = readShapeFor(schemas);
  server.registerTool(
    "mail_search",
    {
      title: "Search mail",
      description:
        "Search one account's Gmail with Gmail query syntax (from:, to:, subject:, has:attachment, is:unread, newer_than:7d, label:, in:anywhere, ...). " +
        "Returns threads newest first with the newest message's id, from, to, subject, date, snippet, labels, unread and hasAttachments. Page with pageToken.",
      inputSchema: z.object({
        account: label,
        query: z.string().min(1).describe("Gmail search query"),
        limit: z.number().int().min(1).max(MAX_SEARCH).default(20),
        pageToken: z.string().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    wrap(async (a) => {
      const c = await mailCtxFor(a.account);
      const page = await c.gmail.listThreads({ q: a.query, maxResults: a.limit, pageToken: a.pageToken });
      const ids = (page.threads ?? []).map((t) => t.id);
      const threads: ThreadSummary[] = [];
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = await Promise.all(ids.slice(i, i + 10).map((id) => c.gmail.getThread(id, "metadata")));
        for (const t of chunk) {
          const s = summarizeThread(t);
          if (s) threads.push(s);
        }
      }
      threads.sort((x, y) => y.date.localeCompare(x.date));
      return { account: a.account, threads, nextPageToken: page.nextPageToken, resultSizeEstimate: page.resultSizeEstimate };
    }),
  );

  server.registerTool(
    "mail_read",
    {
      title: "Read mail",
      description:
        "Read one message (messageId) or a whole thread (threadId, all messages oldest first). Each message has from/to/cc/date/subject, the body as plain text " +
        "(text/plain preferred, else HTML rendered to text; never raw HTML, cut at maxChars per message with bodyTruncated=true) and attachment metadata (filename, mimeType, size, partId, index; " +
        "pass partId or index to mail_attachment, they are stable, Gmail's attachmentId is not).",
      inputSchema: opts.allowSave ? z.object(readShape.full) : (z.object(readShape.readOnly) as unknown as z.ZodObject<typeof readShape.full>),
      annotations: opts.allowSave ? { destructiveHint: false, idempotentHint: true } : { readOnlyHint: true },
    },
    wrap(async (a: { account: string; messageId?: string; threadId?: string; maxChars: number; saveAttachmentsTo?: SaveTarget }, ctx) => {
      if (!a.messageId === !a.threadId) throw new Error("Give exactly one of messageId or threadId");
      if (!opts.allowSave && a.saveAttachmentsTo !== undefined) throw readOnlySaveRefusal("saveAttachmentsTo");
      const c = await mailCtxFor(a.account);
      let threadId: string;
      let messages: ParsedMessage[];
      if (a.messageId) {
        const m = parseMessage(await c.gmail.getMessage(a.messageId, "full"), a.maxChars);
        threadId = m.threadId;
        messages = [m];
      } else {
        const t = await c.gmail.getThread(a.threadId!, "full");
        threadId = t.id;
        messages = (t.messages ?? []).map((m) => parseMessage(m, a.maxChars)).sort((x, y) => x.date.localeCompare(y.date));
      }
      const saved = a.saveAttachmentsTo && opts.allowSave ? await saveAll(c, messages, a.saveAttachmentsTo, actorOf(ctx.http?.authInfo)) : undefined;
      return { notice: UNTRUSTED_NOTICE, account: a.account, threadId, webLink: gmailWebLink(c.email, threadId), messages, ...(saved ? { saved } : {}) };
    }),
  );

  server.registerTool(
    "mail_attachment",
    {
      title: "Read or save an attachment",
      description:
        "Download one attachment of a message: messageId plus partId, index or filename from mail_read (those are stable; Gmail's attachmentId changes between reads and is only a fallback). " +
        "Without saveTo the content is returned as text through the same readers as `read` " +
        "(PDF, docx, xlsx, csv, txt; images and other binaries give metadata only, with a note). " +
        (opts.allowSave
          ? "With saveTo {account, path|folderId, name?, allowNonStandardName?} the bytes are stored as a new Drive file in that account (multipart up to 5 MB, resumable above) and the file is returned; audit-logged."
          : "Saving to Drive needs a full-access token."),
      inputSchema: z.object({
        account: label,
        messageId: z.string().min(1),
        partId: z.string().min(1).optional().describe("Stable selector: partId from mail_read"),
        index: z.number().int().min(0).optional().describe("Stable selector: index from mail_read (0-based position among the message's attachments)"),
        filename: z.string().min(1).optional().describe("Selector: attachment filename (must be unique in the message)"),
        attachmentId: z.string().min(1).optional().describe("Volatile: Gmail changes it between reads; used only when nothing else is given"),
        maxChars: z.number().int().min(100).max(200_000).default(20_000),
        offset: z.number().int().min(0).default(0),
        ...(opts.allowSave ? { saveTo } : ({} as { saveTo?: typeof saveTo })),
      } as {
        account: typeof label;
        messageId: z.ZodString;
        partId: z.ZodOptional<z.ZodString>;
        index: z.ZodOptional<z.ZodNumber>;
        filename: z.ZodOptional<z.ZodString>;
        attachmentId: z.ZodOptional<z.ZodString>;
        maxChars: z.ZodDefault<z.ZodNumber>;
        offset: z.ZodDefault<z.ZodNumber>;
        saveTo: typeof saveTo;
      }),
      annotations: opts.allowSave ? { destructiveHint: false } : { readOnlyHint: true },
    },
    wrap(async (a: { account: string; messageId: string; partId?: string; index?: number; filename?: string; attachmentId?: string; maxChars: number; offset: number; saveTo?: SaveTarget }, ctx) => {
      if (!opts.allowSave && a.saveTo !== undefined) throw readOnlySaveRefusal("saveTo");
      const c = await mailCtxFor(a.account);
      const info: AttachmentInfo = await attachmentInfo(c, a.messageId, { partId: a.partId, index: a.index, filename: a.filename, attachmentId: a.attachmentId });
      const bytes = await downloadAttachment(c, a.messageId, info);
      const base = { account: a.account, messageId: a.messageId, partId: info.partId, index: info.index, filename: info.filename, mimeType: info.mimeType, size: bytes.length };
      if (a.saveTo && opts.allowSave) {
        return { ...base, saved: await saveAttachment(c, a.messageId, info, bytes, a.saveTo, actorOf(ctx.http?.authInfo)) };
      }
      return { notice: UNTRUSTED_NOTICE, ...base, ...(await attachmentText(info, bytes, a.maxChars, a.offset)) };
    }),
  );

  server.registerTool(
    "mail_labels",
    {
      title: "List labels",
      description: "All Gmail labels of an account (system ones like INBOX, UNREAD, STARRED, TRASH and user labels) with id, name, type and unread counts.",
      inputSchema: z.object({ account: label }),
      annotations: { readOnlyHint: true },
    },
    wrap(async (a) => {
      const c = await mailCtxFor(a.account);
      const labels = await c.gmail.listLabels();
      return {
        account: a.account,
        labels: labels
          .map((l) => ({ id: l.id, name: l.name, type: l.type, messagesTotal: l.messagesTotal, messagesUnread: l.messagesUnread }))
          .sort((x, y) => (x.type ?? "").localeCompare(y.type ?? "") || x.name.localeCompare(y.name)),
      };
    }),
  );
}

export function registerMailWriteTools(server: McpServer) {
  server.registerTool(
    "mail_draft",
    {
      title: "Create draft",
      description:
        "Create a Gmail draft in the given account (nothing is sent). Allowed whenever the account's mail setting is draft or send. Plain-text body, rendered as text + HTML; replyToMessageId threads it as a reply; attachments come from Drive. " +
        "Returns draftId, threadId and a Gmail web link to review it. Send later with mail_send {account, draftId}. Audit-logged with recipients and subject.",
      inputSchema: z.object({ account: label, ...composeFields }),
      annotations: { destructiveHint: false },
    },
    wrap(async (a, ctx) => {
      const c = await mailCtxFor(a.account, "draft");
      const composed = await compose(c, { ...a, attachments: a.attachments as AttachmentRef[] | undefined });
      const draft = await c.gmail.createDraft(composed.raw, composed.threadId);
      await mailAudit(c, "mail_draft", actorOf(ctx.http?.authInfo), composed, a.subject, { draftId: draft.id, messageId: draft.message.id, threadId: draft.message.threadId });
      return {
        account: a.account,
        draftId: draft.id,
        messageId: draft.message.id,
        threadId: draft.message.threadId,
        to: a.to,
        cc: a.cc ?? [],
        bcc: a.bcc ?? [],
        subject: a.subject,
        attachments: composed.attachments,
        webLink: gmailWebLink(c.email, draft.message.threadId, "drafts"),
      };
    }),
  );

  server.registerTool(
    "mail_send",
    {
      title: "Send mail",
      description:
        "Send e-mail from the given account: either an existing draft ({account, draftId}) or a new message with the same fields as mail_draft (to, subject, body, optional cc/bcc/replyToMessageId/attachments). " +
        "account is required and is the sender; it is never inferred. Refused for accounts whose mail setting is draft (create a draft instead) and for recipients outside the server's allow-list when one is configured. " +
        "Returns messageId and threadId. Audit-logged with recipients and subject.",
      inputSchema: z.object({
        account: label,
        draftId: z.string().optional().describe("Send this draft (then give no other field)"),
        to: addresses.optional(),
        cc: addresses.optional(),
        bcc: addresses.optional(),
        subject: z.string().max(998).optional(),
        body: z.string().optional(),
        replyToMessageId: z.string().optional(),
        attachments,
      }),
      annotations: { destructiveHint: false },
    },
    wrap(async (a, ctx) => {
      const c = await mailCtxFor(a.account, "send");
      const actor = actorOf(ctx.http?.authInfo);
      if (a.draftId) {
        if (a.to || a.subject || a.body || a.cc || a.bcc || a.attachments || a.replyToMessageId) throw new Error("Give draftId alone, or the message fields without draftId");
        if (allowedRecipients().length > 0) {
          const d = await c.gmail.getDraft(a.draftId);
          const dh = (n: string) => d.message.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value;
          assertRecipientsAllowed(["to", "cc", "bcc"].flatMap((n) => parseAddressList(dh(n))));
        }
        const sent = await c.gmail.sendDraft(a.draftId);
        await c.gmail
          .getMessage(sent.id, "metadata")
          .then((m) => {
            const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value;
            const recipients = [h("to"), h("cc"), h("bcc")].filter((x): x is string => !!x);
            return mailAudit(c, "mail_send", actor, { raw: "", attachments: [], recipients }, h("subject") ?? "", { draftId: a.draftId, messageId: sent.id, threadId: sent.threadId });
          })
          .catch(() => mailAudit(c, "mail_send", actor, { raw: "", attachments: [], recipients: [] }, "", { draftId: a.draftId, messageId: sent.id, threadId: sent.threadId }));
        return { account: a.account, sent: true, draftId: a.draftId, messageId: sent.id, threadId: sent.threadId, webLink: gmailWebLink(c.email, sent.threadId) };
      }
      if (!a.to?.length || !a.subject || !a.body) throw new Error("Give draftId, or to + subject + body");
      assertRecipientsAllowed([...a.to, ...(a.cc ?? []), ...(a.bcc ?? [])]);
      const composed = await compose(c, { ...a, to: a.to, subject: a.subject, body: a.body, attachments: a.attachments as AttachmentRef[] | undefined });
      const sent = await c.gmail.sendMessage(composed.raw, composed.threadId);
      await mailAudit(c, "mail_send", actor, composed, a.subject, { messageId: sent.id, threadId: sent.threadId });
      return {
        account: a.account,
        sent: true,
        messageId: sent.id,
        threadId: sent.threadId,
        to: a.to,
        cc: a.cc ?? [],
        bcc: a.bcc ?? [],
        subject: a.subject,
        attachments: composed.attachments,
        webLink: gmailWebLink(c.email, sent.threadId),
      };
    }),
  );

  server.registerTool(
    "mail_reply",
    {
      title: "Reply in thread",
      description:
        "Reply to the newest message of a thread from the given account and send it immediately. Recipient is that message's Reply-To or From (when the newest message is your own, its To); " +
        "replyAll=true also copies the other To/Cc addresses. Subject gets Re:, In-Reply-To/References are set, attachments come from Drive. asDraft=true saves the reply as a draft instead of sending " +
        "(required for accounts whose mail setting is draft). Returns messageId and threadId (and draftId for a draft). Audit-logged.",
      inputSchema: z.object({
        account: label,
        threadId: z.string().min(1),
        body: composeFields.body,
        replyAll: z.boolean().default(false),
        attachments,
        asDraft: z.boolean().optional().describe("Save the reply as a Gmail draft instead of sending it"),
      }),
      annotations: { destructiveHint: false },
    },
    wrap(async (a, ctx) => {
      if (a.asDraft) {
        const c = await mailCtxFor(a.account, "draft");
        const target = await replyTarget(c, a.threadId, a.replyAll);
        const composed = await compose(c, { ...target, body: a.body, attachments: a.attachments as AttachmentRef[] | undefined });
        const draft = await c.gmail.createDraft(composed.raw, composed.threadId ?? a.threadId);
        await mailAudit(c, "mail_draft", actorOf(ctx.http?.authInfo), composed, target.subject, { draftId: draft.id, messageId: draft.message.id, threadId: draft.message.threadId });
        return {
          account: a.account,
          sent: false,
          draftId: draft.id,
          messageId: draft.message.id,
          threadId: draft.message.threadId,
          inReplyTo: target.replyToMessageId,
          to: target.to,
          cc: target.cc,
          subject: target.subject,
          attachments: composed.attachments,
          webLink: gmailWebLink(c.email, draft.message.threadId, "drafts"),
        };
      }
      const c = await mailCtxFor(a.account, "send");
      const target = await replyTarget(c, a.threadId, a.replyAll);
      assertRecipientsAllowed([...target.to, ...target.cc]);
      const composed = await compose(c, { ...target, body: a.body, attachments: a.attachments as AttachmentRef[] | undefined });
      const sent = await c.gmail.sendMessage(composed.raw, composed.threadId ?? a.threadId);
      await mailAudit(c, "mail_reply", actorOf(ctx.http?.authInfo), composed, target.subject, { messageId: sent.id, threadId: sent.threadId });
      return {
        account: a.account,
        sent: true,
        messageId: sent.id,
        threadId: sent.threadId,
        inReplyTo: target.replyToMessageId,
        to: target.to,
        cc: target.cc,
        subject: target.subject,
        attachments: composed.attachments,
        webLink: gmailWebLink(c.email, sent.threadId),
      };
    }),
  );

  server.registerTool(
    "mail_label",
    {
      title: "Change labels",
      description:
        "Add/remove labels on one message or a whole thread (label names or ids). Archive = remove INBOX; trash = add TRASH (restorable from Gmail's Trash for 30 days); markRead true/false toggles UNREAD. " +
        "There is no permanent delete. dryRun=true resolves the labels and reports what would change without changing anything. Audit-logged.",
      inputSchema: z.object({
        account: label,
        messageId: z.string().optional(),
        threadId: z.string().optional(),
        add: z.array(z.string().min(1)).max(20).optional(),
        remove: z.array(z.string().min(1)).max(20).optional(),
        markRead: z.boolean().optional(),
        dryRun: z.boolean().optional().describe("Report what would change; change nothing"),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    wrap(async (a, ctx) => changeLabels(await mailCtxFor(a.account, "modify"), a, actorOf(ctx.http?.authInfo))),
  );
}
