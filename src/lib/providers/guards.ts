/**
 * Guards with no adapter imports, so shared modules (ctx.ts, mail.ts,
 * tools.ts) can import them without an import cycle through the Google
 * adapter (which itself imports ctx.ts).
 */
import { accountMode, accountProvider, getAccount, type Account } from "../store";
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

/**
 * Server-side enforcement of Account.mode for the cloud_* tools and transfer: "read" accounts accept no writes from
 * any tool. Like access.ts assertAccountWritable it reads the record fresh from the store (never the per-instance
 * cache) and gives the same message. Always `await` it.
 */
export async function assertWriteMode(account: { label: string }): Promise<void> {
  const fresh: Pick<Account, "mode"> = await getAccount(account.label, { fresh: true });
  if (accountMode(fresh) === "read") throw new Error(`account ${account.label} is read-only; change it on /connect`);
}

