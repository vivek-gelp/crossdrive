/**
 * `find` across accounts: each account is searched in parallel with its own
 * timeout; a failing or slow account is reported in `errors` (and
 * `partial: true`) instead of failing the whole call. Results are merged
 * newest first and paged with one opaque cursor that holds, per account, the
 * Drive page token of the page being consumed and how many of its items were
 * already returned, so no item is skipped when the merge cuts a page.
 *
 * Drive cannot order full-text queries (fullText cannot be combined with orderBy), so each Drive page comes in
 * relevance order. Every page is sorted newest first before merging (which also keeps the "already returned" count
 * meaningful when a page is cut), but pages are not globally ordered by date. Drive can also return an item on two
 * consecutive pages; the cursor remembers short keys of the items already returned and drops repeats.
 */
import { createHash } from "node:crypto";
import { ctxFor, folderFromPath, toResult, type Ctx, type FileResult } from "./ctx";
import type { DriveFile } from "./drive";
import { parsePathArg } from "./paths";

export const FIND_TIMEOUT_MS = 20_000;

export interface FindArgs {
  query: string;
  path?: string;
  folderId?: string;
  mimeType?: string;
  foldersOnly?: boolean;
  includeShared?: boolean;
  modifiedAfter?: string;
  limit: number;
  pageToken?: string;
}

interface AccountCursor {
  /** Drive page token of the page being consumed (absent: first page). */
  t?: string;
  /** Items of that page already returned. */
  s: number;
}

interface Cursor {
  v: 1;
  /** Per-account page size the tokens were issued for. */
  p: number;
  a: Record<string, AccountCursor>;
  /** Short keys of items already returned (newest last, capped at SEEN_CAP); absent in cursors from before 1.0.1. */
  x?: string[];
}

/** How many returned items a cursor remembers for de-duplication. */
export const SEEN_CAP = 200;

function seenKey(label: string, id: string): string {
  return createHash("sha256").update(`${label}:${id}`).digest("base64url").slice(0, 10);
}

const newestFirst = (x: DriveFile, y: DriveFile) => (y.modifiedTime ?? "").localeCompare(x.modifiedTime ?? "");

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(token: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Cursor;
    if (c.v !== 1 || typeof c.p !== "number" || typeof c.a !== "object" || c.a === null) throw new Error("bad");
    return c;
  } catch {
    throw new Error("pageToken is not a find cursor; pass the nextPageToken of a previous find call unchanged");
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface FindResult {
  results: FileResult[];
  /** Per account: items returned in this page. */
  accounts: { account: string; returned: number }[];
  errors: { account: string; error: string }[];
  /** True when at least one account failed or timed out; results are then incomplete. */
  partial: boolean;
  hasMore: boolean;
  nextPageToken?: string;
}

interface AccountPage {
  label: string;
  c: Ctx;
  st: AccountCursor;
  files: DriveFile[];
  next?: string;
}

/** `labels`: the accounts to search (already filtered to connected ones). */
export async function findAcross(labels: string[], a: FindArgs, timeoutMs = FIND_TIMEOUT_MS): Promise<FindResult> {
  const cursor = a.pageToken ? decodeCursor(a.pageToken) : undefined;
  const pageSize = cursor?.p ?? a.limit;
  // A path naming an account limits the search to that account.
  const pathLabel = a.path ? parsePathArg(a.path).label : undefined;
  let targets = pathLabel ? labels.filter((l) => l === pathLabel) : labels;
  if (cursor) targets = targets.filter((l) => cursor.a[l]);

  const settled = await Promise.allSettled(
    targets.map((label) =>
      withTimeout(
        (async (): Promise<AccountPage> => {
          const st = cursor?.a[label] ?? { s: 0 };
          const c = await ctxFor(label);
          const folderId = a.folderId ?? (a.path ? await folderFromPath(c, a.path) : undefined);
          const page = await c.drive.searchPage({
            query: a.query,
            folderId,
            mimeType: a.mimeType,
            foldersOnly: a.foldersOnly,
            includeShared: a.includeShared,
            modifiedAfter: a.modifiedAfter,
            limit: pageSize,
            pageToken: st.t,
          });
          return { label, c, st, files: [...page.files].sort(newestFirst), next: page.nextPageToken };
        })(),
        timeoutMs,
        `account ${label}`,
      ),
    ),
  );

  const pages: AccountPage[] = [];
  const errors: FindResult["errors"] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") pages.push(r.value);
    else errors.push({ account: targets[i]!, error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });

  const seen = new Set(cursor?.x ?? []);
  const isRepeat = (p: AccountPage, f: DriveFile) => seen.has(seenKey(p.label, f.id));
  const pool = pages.flatMap((p) => p.files.slice(p.st.s).flatMap((f) => (isRepeat(p, f) ? [] : [{ p, f }])));
  pool.sort((x, y) => newestFirst(x.f, y.f));
  const taken = pool.slice(0, a.limit);

  const nextState: Record<string, AccountCursor> = {};
  const accounts: FindResult["accounts"] = [];
  for (const p of pages) {
    let n = taken.filter((x) => x.p === p).length;
    accounts.push({ account: p.label, returned: n });
    // The items taken from a page are the newest non-repeats of its (sorted) remainder: advance past them and past
    // any repeats in between, so a cut page resumes exactly where this call stopped.
    let consumed = p.st.s;
    while (consumed < p.files.length) {
      const f = p.files[consumed]!;
      if (isRepeat(p, f)) consumed++;
      else if (n > 0) {
        consumed++;
        n--;
      } else break;
    }
    if (consumed < p.files.length) nextState[p.label] = { t: p.st.t, s: consumed };
    else if (p.next) nextState[p.label] = { t: p.next, s: 0 };
  }
  const hasMore = Object.keys(nextState).length > 0;
  const results = await Promise.all(taken.map((x) => toResult(x.p.c, x.f)));
  const x = [...(cursor?.x ?? []), ...taken.map((t) => seenKey(t.p.label, t.f.id))].slice(-SEEN_CAP);
  return {
    results,
    accounts,
    errors,
    partial: errors.length > 0,
    hasMore,
    ...(hasMore ? { nextPageToken: encodeCursor({ v: 1, p: pageSize, a: nextState, x }) } : {}),
  };
}
