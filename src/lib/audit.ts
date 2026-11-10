import { createHash, randomBytes } from "node:crypto";
import { getStore } from "./store";

/**
 * Append-only audit log. Since 1.0 every entry is its own blob,
 * `audit/YYYY-MM-DD/<id>.json`, so concurrent writes never race on a shared
 * read-modify-write file. Entries written before 1.0 live in per-day
 * `audit/YYYY-MM-DD.jsonl` files; the reader merges both. Every entry has a
 * stable `id` (`<compact timestamp>-<random>`); legacy lines without one get a
 * deterministic `legacy-<date>-<hash>` id.
 */

export interface AuditEntry {
  /** Stable id: `20261110T120000123Z-ab12cd34` (new) or `legacy-2026-11-09-<hash>` (old jsonl lines). Always set on entries returned by this module. */
  id?: string;
  ts: string;
  tool: string;
  account: string;
  fileId?: string;
  name?: string;
  from?: string;
  to?: string;
  /** Owner of the affected item: email, or "me" for the connected account. */
  owner?: string;
  actor: string;
  /** Set on every op executed by one `batch` call. */
  batchId?: string;
  /** `copy`: the account label that received the copy (`account` is the source). */
  toAccount?: string;
  /** share / unshare / transfer_ownership: the e-mail whose access changed. */
  email?: string;
  /** share / transfer_ownership: the role granted. */
  role?: string;
  /** mail_draft / mail_send / mail_reply: every To/Cc/Bcc address and the subject. */
  recipients?: string[];
  subject?: string;
  /** mail_*: Drive attachment file names. */
  attachments?: string[];
  messageId?: string;
  threadId?: string;
  draftId?: string;
  /** mail_label: label ids added / removed. */
  add?: string[];
  remove?: string[];
  /** copy of a folder: items handled by this slice, and whether the copy finished. */
  counts?: { copiedFiles: number; createdFolders: number; shortcuts: number; skipped: number; failed: number };
  done?: boolean;
  /** Free-text context, e.g. "temporary, for a folder copy". */
  note?: string;
  /** upload_begin / put sourceUrl / mail_attachment: byte size of the uploaded or announced file. */
  size?: number;
  /** put with sourceUrl: where the bytes came from. */
  sourceUrl?: string;
  /** undo: the id of the entry that was reversed, and its tool. */
  undoOf?: string;
  undoneTool?: string;
}

const ID_RE = /^(\d{4})(\d{2})(\d{2})T\d{9}Z-[0-9a-f]{8}$/;
const LEGACY_ID_RE = /^legacy-(\d{4}-\d{2}-\d{2})-[0-9a-f]{16}$/;
/** How many days back readAudit looks when no date is given. */
export const AUDIT_LOOKBACK_DAYS = 60;

/** Legacy per-day file (read only since 1.0). */
export function auditPath(date = new Date()): string {
  return `audit/${date.toISOString().slice(0, 10)}.jsonl`;
}

function dayDir(day: string): string {
  return `audit/${day}/`;
}

let seq = 0;

/** Compact timestamp, then a per-process sequence (keeps ids written in the same millisecond in order), then randomness. */
export function newAuditId(at = new Date()): string {
  const compact = at.toISOString().replace(/[-:.]/g, ""); // 20261110T120000123Z
  seq = (seq + 1) % 0x10000;
  return `${compact}-${seq.toString(16).padStart(4, "0")}${randomBytes(2).toString("hex")}`;
}

/** The YYYY-MM-DD day an id was written on, or undefined for ids that are not ours. */
export function auditIdDay(id: string): string | undefined {
  const m = ID_RE.exec(id);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return LEGACY_ID_RE.exec(id)?.[1];
}

/** An entry as stored and returned: always with an id. */
export type StoredAuditEntry = AuditEntry & { id: string };

export async function appendAudit(entry: Omit<AuditEntry, "ts" | "id">): Promise<StoredAuditEntry> {
  const now = new Date();
  const full: StoredAuditEntry = { id: newAuditId(now), ts: now.toISOString(), ...entry };
  await getStore().write(`${dayDir(now.toISOString().slice(0, 10))}${full.id}.json`, JSON.stringify(full));
  return full;
}

function legacyId(day: string, line: string): string {
  return `legacy-${day}-${createHash("sha256").update(line).digest("hex").slice(0, 16)}`;
}

function parseLegacy(day: string, text: string): StoredAuditEntry[] {
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const e = JSON.parse(line) as AuditEntry;
        return [{ ...e, id: e.id ?? legacyId(day, line) }];
      } catch {
        return [];
      }
    });
}

async function readMany(paths: string[]): Promise<StoredAuditEntry[]> {
  const store = getStore();
  const out: StoredAuditEntry[] = [];
  for (let i = 0; i < paths.length; i += 20) {
    const texts = await Promise.all(paths.slice(i, i + 20).map((p) => store.read(p)));
    for (const t of texts) {
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as StoredAuditEntry);
      } catch {
        /* skip a damaged entry */
      }
    }
  }
  return out;
}

/** Every entry of one day (new per-entry blobs plus the legacy jsonl), newest first. */
export async function readAuditDay(day: string, limit = Infinity): Promise<StoredAuditEntry[]> {
  const store = getStore();
  // Ids start with a compact timestamp, so the path order is chronological; read the newest first.
  const paths = (await store.listPaths(dayDir(day))).filter((p) => p.endsWith(".json")).reverse();
  const fresh = await readMany(paths.slice(0, limit === Infinity ? undefined : limit));
  const legacy = parseLegacy(day, (await store.read(`audit/${day}.jsonl`)) ?? "").reverse();
  // Both lists are newest first already; the stable sort only interleaves them by timestamp.
  return [...fresh, ...legacy].sort((a, b) => b.ts.localeCompare(a.ts));
}

function daysBack(from: Date, n: number): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

/** Most recent entries, newest first. With `date` (YYYY-MM-DD) reads one day, else the last AUDIT_LOOKBACK_DAYS days. */
export async function readAudit(limit = 50, date?: string, now = new Date()): Promise<StoredAuditEntry[]> {
  if (date) return (await readAuditDay(date, limit)).slice(0, limit);
  const out: StoredAuditEntry[] = [];
  for (const day of daysBack(now, AUDIT_LOOKBACK_DAYS)) {
    if (out.length >= limit) break;
    out.push(...(await readAuditDay(day, limit - out.length)));
  }
  return out.slice(0, limit);
}

/** One entry by id (new or legacy), or undefined. */
export async function getAuditEntry(id: string): Promise<StoredAuditEntry | undefined> {
  const day = auditIdDay(id);
  if (!day) return undefined;
  if (id.startsWith("legacy-")) return (await readAuditDay(day)).find((e) => e.id === id);
  const text = await getStore().read(`${dayDir(day)}${id}.json`);
  return text ? (JSON.parse(text) as StoredAuditEntry) : undefined;
}

/** Entries of one batch call, newest first (searches the last AUDIT_LOOKBACK_DAYS days). */
export async function findBatchEntries(batchId: string, now = new Date()): Promise<StoredAuditEntry[]> {
  for (const day of daysBack(now, AUDIT_LOOKBACK_DAYS)) {
    const hits = (await readAuditDay(day)).filter((e) => e.batchId === batchId);
    if (hits.length) return hits;
  }
  return [];
}
