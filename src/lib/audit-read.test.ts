import { afterEach, describe, expect, it } from "vitest";
import { AUDIT_LOOKBACK_DAYS, findBatchEntries, newAuditId, readAudit, type StoredAuditEntry } from "./audit";
import { setStore, type TextStore } from "./store";
import { memoryStore } from "./testing/fakeDrive";

/**
 * The 1.0.0 reader walked all 60 look-back days one by one (a listing plus a legacy-file read per day), which took
 * about 55 s on a young deployment. The reader must visit only days that have entries and stop when it has enough.
 */

const NOW = new Date(Date.UTC(2026, 10, 12, 12, 0, 0));
const DAY = 86_400_000;

interface Counted extends TextStore {
  lists: number;
  reads: number;
}

/** A memory store that counts list and read calls; `folded` adds a native listTop (as Vercel Blob has). */
function countingStore(folded: boolean): Counted {
  const inner = memoryStore();
  const s: Counted = {
    kind: "memory",
    lists: 0,
    reads: 0,
    read: (p) => (s.reads++, inner.read(p)),
    write: (p, t) => inner.write(p, t),
    listPaths: (p) => (s.lists++, inner.listPaths(p)),
  };
  if (folded) {
    s.listTop = async (prefix) => {
      s.lists++;
      const folders = new Set<string>();
      const files: string[] = [];
      for (const p of await inner.listPaths(prefix)) {
        const rest = p.slice(prefix.length);
        const i = rest.indexOf("/");
        if (i >= 0) folders.add(prefix + rest.slice(0, i + 1));
        else files.push(p);
      }
      return { folders: [...folders].sort(), files };
    };
  }
  return s;
}

async function seed(store: TextStore) {
  // 300 entries over 3 active days (0, 2 and 9 days ago), a legacy jsonl day 20 days ago, one entry beyond the look-back.
  const write = async (at: Date, extra: Partial<StoredAuditEntry> = {}) => {
    const id = newAuditId(at);
    const e: StoredAuditEntry = { id, ts: at.toISOString(), tool: "mkdir", account: "personal", actor: "alex@example.com", ...extra };
    await store.write(`audit/${at.toISOString().slice(0, 10)}/${id}.json`, JSON.stringify(e));
  };
  for (const [daysAgo, n] of [[0, 120], [2, 100], [9, 80]] as const) {
    for (let i = 0; i < n; i++) await write(new Date(NOW.getTime() - daysAgo * DAY - (i + 1) * 60_000), i === 5 && daysAgo === 9 ? { batchId: "b-1" } : {});
  }
  const legacyDay = new Date(NOW.getTime() - 20 * DAY);
  const lines = [0, 1, 2].map((i) => JSON.stringify({ ts: new Date(legacyDay.getTime() - i * 60_000).toISOString(), tool: "put", account: "personal", actor: "alex@example.com" }));
  await store.write(`audit/${legacyDay.toISOString().slice(0, 10)}.jsonl`, lines.join("\n") + "\n");
  await write(new Date(NOW.getTime() - (AUDIT_LOOKBACK_DAYS + 5) * DAY));
}

afterEach(() => setStore(undefined));

describe.each([
  ["Blob-like store with a folded listing", true],
  ["store without listTop (derived from one full listing)", false],
])("readAudit on a %s", (_name, folded) => {
  it("returns the newest entries with a bounded number of list and read calls", async () => {
    const store = countingStore(folded);
    setStore(store);
    await seed(store);
    store.lists = 0;
    store.reads = 0;

    const top = await readAudit(100, undefined, NOW);
    expect(top).toHaveLength(100);
    expect(top.map((e) => e.ts)).toEqual([...top.map((e) => e.ts)].sort().reverse());
    expect(top[0]?.ts).toBe(new Date(NOW.getTime() - 60_000).toISOString());
    expect(store.lists).toBeLessThanOrEqual(2); // the day listing + today's folder
    expect(store.reads).toBeLessThanOrEqual(100); // only the entries returned; no legacy-file probes on empty days

    store.lists = 0;
    store.reads = 0;
    const all = await readAudit(1000, undefined, NOW);
    expect(all).toHaveLength(303); // 300 new + 3 legacy; the entry beyond the look-back is left out
    expect(all.filter((e) => e.id.startsWith("legacy-"))).toHaveLength(3);
    expect(store.lists).toBeLessThanOrEqual(4); // one listing + three day folders, not 60 days
    expect(store.reads).toBe(301); // 300 entries + the one legacy file
  });

  it("an empty log costs one listing", async () => {
    const store = countingStore(folded);
    setStore(store);
    expect(await readAudit(50, undefined, NOW)).toEqual([]);
    expect(store.lists).toBe(1);
    expect(store.reads).toBe(0);
  });

  it("findBatchEntries visits only days with entries", async () => {
    const store = countingStore(folded);
    setStore(store);
    await seed(store);
    store.lists = 0;
    const hits = await findBatchEntries("b-1", NOW);
    expect(hits).toHaveLength(1);
    expect(store.lists).toBeLessThanOrEqual(4);
  });
});
