/**
 * `changes`: files modified after a point in time across accounts, merged
 * newest first. Read-only; uses a `modifiedTime > ...` query per account.
 */
import { toResult, type Ctx, type FileResult } from "./ctx";

const RELATIVE_RE = /^(\d+)\s*(min|m|h|d|w)$/i;
const UNIT_MS: Record<string, number> = { min: 60_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/**
 * `since` may be a relative span (`30min`, `24h`, `7d`, `2w`), a date (`2026-11-01`,
 * taken as midnight UTC) or an RFC 3339 timestamp. Returns an RFC 3339 string.
 */
export function parseSince(since: string, now: Date = new Date()): string {
  const s = since.trim();
  const rel = RELATIVE_RE.exec(s);
  if (rel) {
    const ms = Number(rel[1]) * UNIT_MS[rel[2]!.toLowerCase()]!;
    return new Date(now.getTime() - ms).toISOString();
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Cannot parse since="${since}". Use a span like 24h, 7d or 2w, a date like 2026-11-01, or an RFC 3339 timestamp.`);
  }
  return d.toISOString();
}

export interface ChangesArgs {
  sinceIso: string;
  limit: number;
  includeShared: boolean;
}

export interface ChangesResult {
  since: string;
  accounts: string[];
  results: FileResult[];
  /** Per account: how many items were fetched (each capped at `limit`), to show when one account dominates. */
  perAccount: Record<string, number>;
}

export async function listChanges(ctxs: Ctx[], a: ChangesArgs): Promise<ChangesResult> {
  const perAccount: Record<string, number> = {};
  const lists = await Promise.all(
    ctxs.map(async (c) => {
      const parts = [`modifiedTime > '${a.sinceIso}'`, "trashed = false"];
      if (!a.includeShared) parts.push("'me' in owners");
      const page = await c.drive.listFiles({ q: parts.join(" and "), orderBy: "modifiedTime desc", pageSize: a.limit });
      perAccount[c.account.label] = page.files.length;
      return Promise.all(page.files.map((f) => toResult(c, f)));
    }),
  );
  const results = lists
    .flat()
    .sort((x, y) => (y.modifiedTime ?? "").localeCompare(x.modifiedTime ?? ""))
    .slice(0, a.limit);
  return { since: a.sinceIso, accounts: ctxs.map((c) => c.account.label), results, perAccount };
}
