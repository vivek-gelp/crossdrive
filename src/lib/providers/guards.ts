/**
 * Guards with no adapter imports, so shared modules (ctx.ts, mail.ts,
 * tools.ts) can import them without an import cycle through the Google
 * adapter (which itself imports ctx.ts).
 */
import { accountMode, accountProvider, type Account } from "../store";
import type { ProviderKind } from "./types";

export const PROVIDER_NAMES: Record<ProviderKind, string> = { google: "Google Drive", microsoft: "OneDrive", dropbox: "Dropbox" };

/**
 * Guard for the Google-only tools (find, list, read, put, copy, share, mail_*,
 * ...): a OneDrive or Dropbox label gets a pointer to the generic tools
 * instead of a confusing Drive API error.
 */
export function assertGoogleAccount(account: { label: string; provider?: Account["provider"] }): void {
  const p = accountProvider(account);
  if (p === "google") return;
  throw new Error(
    `"${account.label}" is a ${PROVIDER_NAMES[p]} account; this tool works on Google accounts only. ` +
      `Use cloud_list / cloud_find / cloud_read / cloud_mkdir / cloud_move / cloud_rename / cloud_trash, or transfer, for ${PROVIDER_NAMES[p]} accounts.`,
  );
}

/** Server-side enforcement of Account.mode: "read" accounts accept no writes from any tool. */
export function assertWriteMode(account: { label: string; mode?: Account["mode"] }): void {
  if (accountMode(account) === "read") throw new Error(`Account "${account.label}" is connected read-only; writes are disabled for it`);
}

