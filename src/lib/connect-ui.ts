import { isValidLabel } from "./config";

/**
 * Pure helpers for the /connect page: label suggestions, the "signed in but not connected" check, and the wording of
 * the result banners. No I/O, so they are unit-tested directly.
 */

/** Labels offered as quick picks in the add form, in this order. */
export const COMMON_LABELS = ["personal", "work", "client"] as const;

const PERSONAL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function inUse(existing: Iterable<string>): Set<string> {
  return new Set([...existing].map((l) => l.toLowerCase()));
}

/** The common labels that are not already taken. */
export function availableLabelSuggestions(existing: Iterable<string>): string[] {
  const taken = inUse(existing);
  return COMMON_LABELS.filter((l) => !taken.has(l));
}

/** `base` if free, otherwise `base-2`, `base-3`, ... (always a valid label). */
export function dedupeLabel(base: string, existing: Iterable<string>): string {
  const taken = inUse(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 24 - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Label to suggest for an e-mail address. Uses only the domain: `personal` for gmail.com / googlemail.com, `work`
 * otherwise, de-duplicated against the labels in use. Nothing from the local part ends up in the label.
 */
export function suggestLabelFor(email: string, existing: Iterable<string>): string {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  return dedupeLabel(PERSONAL_DOMAINS.has(domain) ? "personal" : "work", existing);
}

/** True when the signed-in admin's own e-mail is not among the connected accounts (case-insensitive). */
export function adminNotConnected(adminEmail: string | null | undefined, accounts: readonly { email: string }[]): boolean {
  if (!adminEmail) return false;
  const me = adminEmail.trim().toLowerCase();
  return !accounts.some((a) => a.email.trim().toLowerCase() === me);
}

export function modeText(mode: "read" | "write"): string {
  return mode === "write" ? "read + write" : "read-only";
}

export function mailText(provider: string, mail: "off" | "draft" | "send"): string {
  if (provider !== "google") return "no mail";
  if (mail === "draft") return "mail drafts only";
  if (mail === "send") return "mail can be sent";
  return "mail off";
}

/** Success banner text after a provider callback redirected back with `connected=<label>`. */
export function connectedMessage(
  label: string,
  account: { email: string; provider: string; mode: "read" | "write"; mail: "off" | "draft" | "send" } | undefined,
): string {
  if (!account) return `Connected ${label}.`;
  return `Connected ${account.email} as ${label}: ${modeText(account.mode)}, ${mailText(account.provider, account.mail)}.`;
}

/** Plain explanation for an `error=` value; known OAuth error codes get a readable reason. */
export function describeConnectError(raw: string): string {
  const m = /consent failed: ([a-z_]+)$/i.exec(raw.trim());
  if (m) {
    const code = m[1]!.toLowerCase();
    if (code === "access_denied") return "The consent screen was cancelled or declined, so nothing was connected.";
    return `The provider refused the request (${code}), so nothing was connected.`;
  }
  return raw;
}

/** A query value for pre-filling the add form, or undefined if it is not a plausible label. */
export function prefillLabel(v: unknown): string | undefined {
  return typeof v === "string" && isValidLabel(v) ? v : undefined;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/** A query value for pre-filling the e-mail field, or undefined. */
export function prefillEmail(v: unknown): string | undefined {
  return typeof v === "string" && EMAIL_RE.test(v) ? v : undefined;
}

export type StepState = "done" | "next" | "todo";

/** The three-step progress line at the top of /connect. */
export function progressSteps(signedIn: boolean, connected: number): { label: string; state: StepState }[] {
  return [
    { label: "Sign in", state: signedIn ? "done" : "next" },
    { label: "Connect an account", state: connected > 0 ? "done" : signedIn ? "next" : "todo" },
    { label: "Add Crossdrive to your AI client", state: connected > 0 ? "next" : "todo" },
  ];
}
