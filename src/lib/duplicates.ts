/**
 * Duplicate detection: scan an account (or a subtree) with paged files.list
 * calls, group by md5Checksum, else by (name, size) for Google-native files,
 * and rank groups by wasted bytes. Read-only.
 */
import { toResult, type Ctx } from "./ctx";
import { escapeQ, FOLDER_MIME, type DriveClient, type DriveFile } from "./drive";
import { isGoogleNativeMime } from "./naming";

export const MAX_SCAN_PAGES = 20;
export const MAX_SUBTREE_FOLDERS = 2000;
export const MAX_GROUPS = 200;
const PARENTS_PER_QUERY = 40;

export interface DuplicateFile {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  owner: string;
}

export interface DuplicateGroup {
  /** `md5:<checksum>` or `name:<name>|<size>` (Google-native files, which have no checksum). */
  key: string;
  name: string;
  size?: number;
  count: number;
  wastedBytes: number;
  /** Id of the copy to keep: shortest path, ties go to the oldest file. */
  suggestedKeep: string;
  files: DuplicateFile[];
}

export interface DuplicatesResult {
  account: string;
  scope: "mine" | "all";
  scannedFiles: number;
  /** True when the scan stopped at the page cap and may have missed files. */
  scanTruncated: boolean;
  groups: DuplicateGroup[];
  totals: { groups: number; duplicateFiles: number; wastedBytes: number };
  /** True when more than MAX_GROUPS groups were found and only the first MAX_GROUPS (by wasted bytes) are returned. */
  truncated: boolean;
}

export function groupKey(f: DriveFile): string | undefined {
  if (f.md5Checksum) return `md5:${f.md5Checksum}`;
  if (isGoogleNativeMime(f.mimeType) && f.mimeType !== FOLDER_MIME) return `name:${f.name}|${f.size ?? ""}`;
  return undefined;
}

/** Pure grouping: files below `minSize` (when their size is known) are ignored; groups need at least two files. */
export function groupDuplicates(files: DriveFile[], minSize: number): DriveFile[][] {
  const groups = new Map<string, DriveFile[]>();
  for (const f of files) {
    if (f.mimeType === FOLDER_MIME || f.trashed) continue;
    if (f.size !== undefined && Number(f.size) < minSize) continue;
    const key = groupKey(f);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Shortest path wins; among equal lengths the oldest modifiedTime. */
export function pickKeep<T extends { id: string; path: string; modifiedTime?: string }>(files: T[]): T {
  return files.reduce((best, f) => {
    if (f.path.length < best.path.length) return f;
    if (f.path.length === best.path.length && (f.modifiedTime ?? "") < (best.modifiedTime ?? "")) return f;
    return best;
  });
}

/** Breadth-first ids of `rootFolderId` and every folder below it, capped at MAX_SUBTREE_FOLDERS. */
export async function collectSubtreeFolders(drive: DriveClient, rootFolderId: string, cap = MAX_SUBTREE_FOLDERS): Promise<{ ids: string[]; truncated: boolean }> {
  const ids = [rootFolderId];
  const seen = new Set(ids);
  let frontier = [rootFolderId];
  while (frontier.length && ids.length < cap) {
    const next: string[] = [];
    for (let i = 0; i < frontier.length; i += PARENTS_PER_QUERY) {
      const chunk = frontier.slice(i, i + PARENTS_PER_QUERY);
      const q = `(${chunk.map((p) => `'${escapeQ(p)}' in parents`).join(" or ")}) and mimeType = '${FOLDER_MIME}' and trashed = false`;
      let pageToken: string | undefined;
      do {
        const page = await drive.listFiles({ q, pageSize: 1000, pageToken, fields: "id" });
        for (const f of page.files) {
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          ids.push(f.id);
          next.push(f.id);
          if (ids.length >= cap) return { ids, truncated: true };
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    frontier = next;
  }
  return { ids, truncated: false };
}

export interface ScanOpts {
  scope: "mine" | "all";
  /** Restrict to files whose parent is one of these folders (from collectSubtreeFolders). */
  parentIds?: string[];
  maxPages?: number;
}

/** Non-folder, non-trashed files of the account (or of the given parents), at most `maxPages` pages of 1000. */
export async function scanFiles(drive: DriveClient, opts: ScanOpts): Promise<{ files: DriveFile[]; truncated: boolean }> {
  const maxPages = opts.maxPages ?? MAX_SCAN_PAGES;
  const base = ["trashed = false", `mimeType != '${FOLDER_MIME}'`];
  if (opts.scope === "mine") base.push("'me' in owners");
  const parentChunks: (string[] | undefined)[] = opts.parentIds
    ? Array.from({ length: Math.ceil(opts.parentIds.length / PARENTS_PER_QUERY) }, (_, i) => opts.parentIds!.slice(i * PARENTS_PER_QUERY, (i + 1) * PARENTS_PER_QUERY))
    : [undefined];
  const files: DriveFile[] = [];
  const seen = new Set<string>();
  let pages = 0;
  for (const chunk of parentChunks) {
    const parts = chunk ? [...base, `(${chunk.map((p) => `'${escapeQ(p)}' in parents`).join(" or ")})`] : base;
    let pageToken: string | undefined;
    do {
      if (pages >= maxPages) return { files, truncated: true };
      const page = await drive.listFiles({ q: parts.join(" and "), pageSize: 1000, pageToken });
      pages++;
      for (const f of page.files) {
        if (!seen.has(f.id)) {
          seen.add(f.id);
          files.push(f);
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  return { files, truncated: false };
}

export interface DuplicatesArgs {
  scope: "mine" | "all";
  /** Root folder of the subtree to scan (already resolved); whole account when absent. */
  folderId?: string;
  minSize: number;
}

export async function findDuplicates(c: Ctx, a: DuplicatesArgs): Promise<DuplicatesResult & { subtreeTruncated?: boolean }> {
  let parentIds: string[] | undefined;
  let subtreeTruncated: boolean | undefined;
  if (a.folderId) {
    const sub = await collectSubtreeFolders(c.drive, a.folderId);
    parentIds = sub.ids;
    subtreeTruncated = sub.truncated;
  }
  const scan = await scanFiles(c.drive, { scope: a.scope, parentIds });
  const raw = groupDuplicates(scan.files, a.minSize)
    .map((files) => {
      const size = files[0]!.size !== undefined ? Number(files[0]!.size) : undefined;
      return { files, size, wastedBytes: (size ?? 0) * (files.length - 1) };
    })
    .sort((x, y) => y.wastedBytes - x.wastedBytes || y.files.length - x.files.length || x.files[0]!.name.localeCompare(y.files[0]!.name));
  const totals = {
    groups: raw.length,
    duplicateFiles: raw.reduce((n, g) => n + g.files.length - 1, 0),
    wastedBytes: raw.reduce((n, g) => n + g.wastedBytes, 0),
  };
  // Paths are only resolved for the groups actually returned.
  const groups: DuplicateGroup[] = [];
  for (const g of raw.slice(0, MAX_GROUPS)) {
    const files: DuplicateFile[] = [];
    for (const f of g.files) {
      const r = await toResult(c, f);
      files.push({ id: r.id, name: r.name, path: r.path, mimeType: r.mimeType, size: r.size, modifiedTime: r.modifiedTime, owner: r.owner });
    }
    files.sort((x, y) => x.path.length - y.path.length || (x.modifiedTime ?? "").localeCompare(y.modifiedTime ?? ""));
    groups.push({
      key: groupKey(g.files[0]!)!,
      name: g.files[0]!.name,
      size: g.size,
      count: g.files.length,
      wastedBytes: g.wastedBytes,
      suggestedKeep: pickKeep(files).id,
      files,
    });
  }
  return {
    account: c.account.label,
    scope: a.scope,
    scannedFiles: scan.files.length,
    scanTruncated: scan.truncated,
    subtreeTruncated,
    groups,
    totals,
    truncated: raw.length > MAX_GROUPS,
  };
}
