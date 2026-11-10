/**
 * `duplicates acrossAccounts=true`: files with the same md5Checksum and size
 * in two or more connected accounts. Each account's owned files (scope
 * "mine", so a file shared between accounts is not counted twice) are scanned
 * with the same paged scan as single-account duplicates; an account that
 * fails is reported in `errors` and the result marked `partial`. Read-only.
 */
import { ctxFor, toResult } from "./ctx";
import { MAX_GROUPS, scanFiles } from "./duplicates";
import type { DriveFile } from "./drive";
import type { Ctx } from "./ctx";

export interface CrossFile {
  account: string;
  id: string;
  name: string;
  path: string;
  size?: number;
  modifiedTime?: string;
}

export interface CrossGroup {
  md5: string;
  size: number;
  accounts: string[];
  count: number;
  files: CrossFile[];
}

export interface CrossDuplicatesResult {
  acrossAccounts: true;
  accounts: string[];
  scannedFiles: Record<string, number>;
  scanTruncated: string[];
  groups: CrossGroup[];
  totals: { groups: number; files: number; bytesInOtherAccounts: number };
  truncated: boolean;
  errors: { account: string; error: string }[];
  partial: boolean;
}

/** Pure grouping: md5 + size, kept only when the files span two or more accounts. */
export function groupAcrossAccounts(byAccount: { account: string; files: DriveFile[] }[], minSize: number): { md5: string; size: number; items: { account: string; file: DriveFile }[] }[] {
  const groups = new Map<string, { md5: string; size: number; items: { account: string; file: DriveFile }[] }>();
  for (const { account, files } of byAccount) {
    for (const f of files) {
      if (!f.md5Checksum || f.size === undefined || f.trashed) continue;
      const size = Number(f.size);
      if (size < minSize) continue;
      const key = `${f.md5Checksum}|${size}`;
      const g = groups.get(key) ?? { md5: f.md5Checksum, size, items: [] };
      g.items.push({ account, file: f });
      groups.set(key, g);
    }
  }
  return [...groups.values()].filter((g) => new Set(g.items.map((i) => i.account)).size >= 2).sort((x, y) => y.size - x.size || x.md5.localeCompare(y.md5));
}

export async function findCrossAccountDuplicates(labels: string[], minSize: number): Promise<CrossDuplicatesResult> {
  const settled = await Promise.allSettled(
    labels.map(async (label) => {
      const c = await ctxFor(label);
      const scan = await scanFiles(c.drive, { scope: "mine" });
      return { label, c, scan };
    }),
  );
  const ok: { label: string; c: Ctx; scan: { files: DriveFile[]; truncated: boolean } }[] = [];
  const errors: CrossDuplicatesResult["errors"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push(r.value);
    else errors.push({ account: labels[i]!, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  const raw = groupAcrossAccounts(
    ok.map((x) => ({ account: x.label, files: x.scan.files })),
    minSize,
  );
  const ctxOf = new Map(ok.map((x) => [x.label, x.c]));
  const groups: CrossGroup[] = [];
  for (const g of raw.slice(0, MAX_GROUPS)) {
    const files: CrossFile[] = [];
    for (const it of g.items) {
      const r = await toResult(ctxOf.get(it.account)!, it.file);
      files.push({ account: it.account, id: r.id, name: r.name, path: r.path, size: r.size, modifiedTime: r.modifiedTime });
    }
    groups.push({ md5: g.md5, size: g.size, accounts: [...new Set(files.map((f) => f.account))].sort(), count: files.length, files });
  }
  return {
    acrossAccounts: true,
    accounts: ok.map((x) => x.label),
    scannedFiles: Object.fromEntries(ok.map((x) => [x.label, x.scan.files.length])),
    scanTruncated: ok.filter((x) => x.scan.truncated).map((x) => x.label),
    groups,
    totals: {
      groups: raw.length,
      files: raw.reduce((n, g) => n + g.items.length, 0),
      // Bytes held more than once: every copy beyond the first in another account.
      bytesInOtherAccounts: raw.reduce((n, g) => n + g.size * (g.items.length - 1), 0),
    },
    truncated: raw.length > MAX_GROUPS,
    errors,
    partial: errors.length > 0,
  };
}
