/**
 * Server-side access gates per connected account: the account `mode`
 * ("read" blocks every write tool, Drive and mail) and the `mail` capability
 * ("off" hides mail, "draft" allows drafts but no sending, "send" allows
 * sending, optionally only to CROSSDRIVE_MAIL_ALLOWED_RECIPIENTS). Enforced in
 * code before any Google call, never only through tool annotations.
 */
import { env } from "./config";
import { accountMail, accountMode, getAccount, type Account } from "./store";

/** Structural on purpose: labels are free-form strings. */
type AccountLike = { label: string } & Pick<Account, "mode" | "mail">;

export class AccessError extends Error {}

/** The refusal every write tool gives for a read-only account, on every provider. */
export function readOnlyMessage(label: string): string {
  return `account ${label} is read-only; change it on /connect`;
}

/** Pure check on a record already in hand. Write paths use assertAccountWritable, which re-reads the record. */
export function checkAccountWritable(account: AccountLike): void {
  if (accountMode(account) === "read") throw new AccessError(readOnlyMessage(account.label));
}

/**
 * Throws unless the account may be written to. The mode is read fresh from the store (one read per call), never
 * from the per-instance account cache: serverless instances do not share memory, so a switch to read-only (or a
 * disconnect) made on /connect must hold on every instance at once. Always `await` it.
 */
export async function assertAccountWritable(account: { label: string }): Promise<void> {
  checkAccountWritable(await getAccount(account.label, { fresh: true }));
}

/**
 * What a mail tool needs: `read` (search/read/labels/attachments), `modify`
 * (labels, archive, trash), `draft` (create a draft), `send` (send or reply).
 */
export type MailNeed = "read" | "modify" | "draft" | "send";

/** Pure check on a record already in hand; mailCtxFor passes the record it read fresh from the store. */
export function assertMailAllowed(account: AccountLike, need: MailNeed): void {
  const mail = accountMail(account);
  if (mail === "off") throw new AccessError(`mail is turned off for account ${account.label}; change it on /connect`);
  if (need === "read") return;
  checkAccountWritable(account);
  if (need === "send" && mail === "draft") {
    throw new AccessError(
      `account ${account.label} may only create drafts (mail mode "draft"): nothing was sent. Create a draft with mail_draft instead (for a reply pass replyToMessageId) and let the user send it from Gmail.`,
    );
  }
}

/** CROSSDRIVE_MAIL_ALLOWED_RECIPIENTS (legacy VAULT_ accepted): comma-separated addresses and/or @domains. Empty means anyone. */
export function allowedRecipients(): string[] {
  return (env("MAIL_ALLOWED_RECIPIENTS") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Bare lower-cased address of `Name <a@b>` or `a@b`. */
export function bareAddress(addr: string): string {
  const m = /<([^<>]+)>\s*$/.exec(addr);
  return (m ? m[1]! : addr).trim().toLowerCase();
}

export function recipientAllowed(addr: string, allow: string[]): boolean {
  if (allow.length === 0) return true;
  const a = bareAddress(addr);
  const domain = a.slice(a.lastIndexOf("@"));
  return allow.some((x) => (x.startsWith("@") ? domain === x : a === x));
}

/** Throws when any recipient is outside CROSSDRIVE_MAIL_ALLOWED_RECIPIENTS (when that is set). */
export function assertRecipientsAllowed(recipients: string[]): void {
  const allow = allowedRecipients();
  if (allow.length === 0) return;
  const refused = recipients.filter((r) => !recipientAllowed(r, allow));
  if (refused.length) {
    throw new AccessError(
      `refused: ${refused.map(bareAddress).join(", ")} ${refused.length === 1 ? "is" : "are"} not in the allowed recipients of this server (CROSSDRIVE_MAIL_ALLOWED_RECIPIENTS). Nothing was sent; create a draft with mail_draft instead.`,
    );
  }
}
