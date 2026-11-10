/**
 * Entry points: pick the adapter for a connected account, parse
 * `label:/path` references, and the guards shared by the tools.
 */
import { accountProvider, getAccount, type Account } from "../store";
import { DropboxProvider } from "./dropbox";
import { isValidLabel } from "./env";
import { GoogleProvider } from "./google";
import { OneDriveProvider } from "./onedrive";
import { providerAccessToken } from "./tokens";
import type { StorageProvider } from "./types";

export function providerForAccount(account: Account): StorageProvider {
  const token = () => providerAccessToken(account);
  switch (accountProvider(account)) {
    case "microsoft":
      return new OneDriveProvider(account.label, token);
    case "dropbox":
      return new DropboxProvider(account.label, token);
    default:
      return new GoogleProvider(account.label, token);
  }
}

export async function providerFor(label: string): Promise<{ account: Account; provider: StorageProvider }> {
  const account = await getAccount(label);
  return { account, provider: providerForAccount(account) };
}

export { assertGoogleAccount, assertWriteMode, PROVIDER_NAMES } from "./guards";

export interface ParsedRef {
  label: string;
  /** Slash path from the account root; `/` for the root. */
  path: string;
}

/** `label:/A/B` (or `label:A/B`, `label:`) → { label, path: "/A/B" }. */
export function parseRef(ref: string): ParsedRef {
  const m = /^([^:/]+):(.*)$/.exec(ref.trim());
  if (!m) throw new Error(`Expected label:/path (e.g. personal:/Projects/Report.pdf), got "${ref}"`);
  const label = m[1]!;
  if (!isValidLabel(label)) throw new Error(`Invalid account label "${label}"`);
  const segs = (m[2] ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  if (segs.some((s) => s === ".." || s === ".")) throw new Error('Path segments may not be "." or ".."');
  return { label, path: segs.length ? `/${segs.join("/")}` : "/" };
}

export type { Entry, StorageProvider } from "./types";
