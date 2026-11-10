/**
 * Optional file naming rule, chosen with CROSSDRIVE_NAMING_RULE (legacy VAULT_NAMING_RULE):
 *  - "off" (default): any name is accepted;
 *  - "date-entity": YYYY-MM-DD_Company_WhatItIs.ext for uploads and renames.
 * Google-native types (Docs, Sheets, Slides, folders, ...) are always exempt.
 */

import { env } from "./config";

export const NAMING_RULE = "YYYY-MM-DD_Company_WhatItIs.ext";

export type NamingRuleSetting = "off" | "date-entity";

/** The active naming rule from CROSSDRIVE_NAMING_RULE; anything unrecognised means "off". */
export function namingRule(): NamingRuleSetting {
  const v = (env("NAMING_RULE") ?? "").trim().toLowerCase();
  return v === "date-entity" ? "date-entity" : "off";
}

export function namingRuleEnabled(): boolean {
  return namingRule() !== "off";
}

const NAME_RE =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])_[A-Za-z0-9][A-Za-z0-9-]*_[A-Za-z0-9][A-Za-z0-9 ._()&-]*\.[A-Za-z0-9]{1,8}$/;

export type NameCheck = { ok: true } | { ok: false; reason: string };

/** Pure check against the date-entity rule (independent of CROSSDRIVE_NAMING_RULE). */
export function validateName(name: string): NameCheck {
  if (!name || /[\\/\x00-\x1f]/.test(name)) {
    return { ok: false, reason: `Name must not be empty or contain path separators; expected ${NAMING_RULE}` };
  }
  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `"${name}" does not follow the naming rule ${NAMING_RULE} (e.g. 2026-11-09_Acme_BoardDeck.pdf). Pass allowNonStandardName=true to override.`,
    };
  }
  return { ok: true };
}

export function isGoogleNativeMime(mimeType: string | undefined): boolean {
  return !!mimeType && mimeType.startsWith("application/vnd.google-apps.");
}
