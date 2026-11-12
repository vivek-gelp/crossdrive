/**
 * `duplicates acrossAccounts=true`: files with the same md5Checksum and size
 * in two or more connected accounts. Each account's owned files (scope
 * "mine", so a file shared between accounts is not counted twice) are scanned
 * with the same paged scan as single-account duplicates; an account that
 * fails is reported in `errors` and the result marked `partial`. Read-only.
 *
 * Scoping: an account may be restricted to one folder and everything below it
 * (`scopes`, from `path` / `paths` / `account`+`folderId`); accounts without a
 * scope are scanned whole. Accounts are scanned in parallel, at most
 * SCAN_CONCURRENCY at a time.
 *
 * Paging: groups are sorted (largest first, then md5) and returned `limit` at a
 * time; `cursor` continues where the previous page stopped, so nothing is ever
 * cut silently. Every page carries the full counts (`totals`, `page`).
 */
import { ctxFor, toResult } from "./ctx";
import { collectSubtreeFolders, scanFiles } from "./duplicates";
import type { DriveFile } from "./drive";
import type { Ctx } from "./ctx";

export const SCAN_CONCURRENCY = 4;
export const DEFAULT_CROSS_LIMIT = 25;
export const MAX_CROSS_LIMIT = 200;

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
  /** Per account: the folder the scan was restricted to (absent: the whole account). */
  scopes: Record<string, string>;
  minSize: number;
  scannedFiles: Record<string, number>;
  scanTruncated: string[];
  /** Accounts whose subtree had more folders than the subtree cap (the scope was cut). */
  subtreeTruncated: string[];
  groups: CrossGroup[];
  totals: { groups: number; files: number; bytesInOtherAccounts: number };
  page: { offset: number; returned: number; totalGroups: number; hasMore: boolean; cursor?: string };
  /** True when more groups exist than this page returned: follow page.cursor. */
  truncated: boolean;
  errors: { account: string; error: string }[];
  partial: boolean;
}

export interface CrossDuplicatesOpts {
  minSize: number;
  /** label -> folder id: restrict that account to the folder and everything below it. */
  scopes?: Record<string, string>;
  limit?: number;
  cursor?: string;
}

interface CursorState {
  v: 1;
  offset: number;
  /** Fingerprint of the query, so a cursor is not applied to a different one. */
  q: string;
}

function fingerprint(labels: string[], o: CrossDuplicatesOpts): string {
  const scopes = Object.entries(o.scopes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([[...labels].sort(), scopes, o.minSize]);
}

function encodeCursor(c: CursorState): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(s: string, q: string): number {
  let c: CursorState;
  try {
    c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as CursorState;
  } catch {
    throw new Error("Invalid cursor: pass back page.cursor from the previous duplicates call unchanged");
  }
  if (c?.v !== 1 || typeof c.offset !== "number" || c.offset < 0) throw new Error("Invalid cursor (unknown format)");
  if (c.q !== q) throw new Error("This cursor belongs to a different duplicates query; pass the same accounts, path/folderId and minSize");
  return c.offset;
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

/** Run `fn` over `items` with at most `n` in flight; results keep the input order. */
export async function mapBounded<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

export async function findCrossAccountDuplicates(labels: string[], minSizeOrOpts: number | CrossDuplicatesOpts): Promise<CrossDuplicatesResult> {
  const o: CrossDuplicatesOpts = typeof minSizeOrOpts === "number" ? { minSize: minSizeOrOpts } : minSizeOrOpts;
  const scopes = o.scopes ?? {};
  const limit = Math.min(Math.max(o.limit ?? DEFAULT_CROSS_LIMIT, 1), MAX_CROSS_LIMIT);
  const q = fingerprint(labels, o);
  const offset = o.cursor ? decodeCursor(o.cursor, q) : 0;
  const settled = await mapBounded(labels, SCAN_CONCURRENCY, async (label) => {
    const c = await ctxFor(label);
    let parentIds: string[] | undefined;
    let subtreeTruncated = false;
    const scope = scopes[label];
    if (scope) {
      const sub = await collectSubtreeFolders(c.drive, scope);
      parentIds = sub.ids;
      subtreeTruncated = sub.truncated;
    }
    const scan = await scanFiles(c.drive, { scope: "mine", parentIds });
    return { label, c, scan, subtreeTruncated };
  });
  const ok: { label: string; c: Ctx; scan: { files: DriveFile[]; truncated: boolean }; subtreeTruncated: boolean }[] = [];
  const errors: CrossDuplicatesResult["errors"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push(r.value);
    else errors.push({ account: labels[i]!, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  const raw = groupAcrossAccounts(
    ok.map((x) => ({ account: x.label, files: x.scan.files })),
    o.minSize,
  );
  const ctxOf = new Map(ok.map((x) => [x.label, x.c]));
  const pageGroups = raw.slice(offset, offset + limit);
  // Paths are resolved only for the groups on this page.
  const groups = await Promise.all(
    pageGroups.map(async (g): Promise<CrossGroup> => {
      const files: CrossFile[] = [];
      for (const it of g.items) {
        const r = await toResult(ctxOf.get(it.account)!, it.file);
        files.push({ account: it.account, id: r.id, name: r.name, path: r.path, size: r.size, modifiedTime: r.modifiedTime });
      }
      return { md5: g.md5, size: g.size, accounts: [...new Set(files.map((f) => f.account))].sort(), count: files.length, files };
    }),
  );
  const hasMore = offset + pageGroups.length < raw.length;
  return {
    acrossAccounts: true,
    accounts: ok.map((x) => x.label),
    scopes,
    minSize: o.minSize,
    scannedFiles: Object.fromEntries(ok.map((x) => [x.label, x.scan.files.length])),
    scanTruncated: ok.filter((x) => x.scan.truncated).map((x) => x.label),
    subtreeTruncated: ok.filter((x) => x.subtreeTruncated).map((x) => x.label),
    groups,
    totals: {
      groups: raw.length,
      files: raw.reduce((n, g) => n + g.items.length, 0),
      // Bytes held more than once: every copy beyond the first in another account.
      bytesInOtherAccounts: raw.reduce((n, g) => n + g.size * (g.items.length - 1), 0),
    },
    page: { offset, returned: groups.length, totalGroups: raw.length, hasMore, ...(hasMore ? { cursor: encodeCursor({ v: 1, offset: offset + pageGroups.length, q }) } : {}) },
    truncated: hasMore,
    errors,
    partial: errors.length > 0,
  };
}
