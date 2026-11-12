import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAudit } from "../audit";
import { DROPBOX_CHUNK } from "./dropbox";
import { ONEDRIVE_CHUNK } from "./onedrive";
import { setupHarness, teardownHarness, type Harness } from "./testing/harness";
import { decodeTransferCursor, rechunk, transfer, type TransferPlan, type TransferResult } from "./transfer";

vi.mock("../store", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../store")>();
  const { providerStoreMock } = await import("./testing/storeMock");
  return { ...orig, ...providerStoreMock() };
});

const actor = "tester@example.com";
let h: Harness;

beforeEach(() => {
  h = setupHarness();
});
afterEach(() => teardownHarness());

async function run(args: Parameters<typeof transfer>[0], now?: () => number): Promise<TransferResult> {
  const r = await transfer({ dryRun: false, ...args }, { actor, now });
  expect("dryRun" in r).toBe(false);
  return r as TransferResult;
}

/** Follow the cursor until done; returns every slice. */
async function runAll(args: Parameters<typeof transfer>[0], limit = 50): Promise<TransferResult[]> {
  const out: TransferResult[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < limit; i++) {
    const r = await run({ ...args, cursor });
    out.push(r);
    if (r.done) return out;
    cursor = r.cursor;
  }
  throw new Error("transfer did not finish");
}

const text = (u: Uint8Array | undefined) => new TextDecoder().decode(u);

describe("rechunk", () => {
  it("cuts any stream into exact pieces, the last one shorter", async () => {
    async function* src() {
      for (const n of [3, 10, 1, 7]) yield new Uint8Array(n).fill(n);
    }
    const sizes: number[] = [];
    for await (const c of rechunk(src(), 4)) sizes.push(c.length);
    expect(sizes).toEqual([4, 4, 4, 4, 4, 1]);
  });
});

describe("transfer OneDrive -> Dropbox (folder tree)", () => {
  beforeEach(() => {
    h.ms.put("work", "/Reports/2026/q1.txt", "first quarter");
    h.ms.put("work", "/Reports/2026/q2.txt", "second quarter");
    h.ms.put("work", "/Reports/readme.md", "# reports");
    h.ms.put("work", "/Reports/Empty");
    h.dbx.put("client-a", "/Inbox");
  });

  it("copies the tree, verifies every file by hash and is idempotent on a re-run", async () => {
    const [r] = await runAll({ from: "work:/Reports", to: "client-a:/Inbox" });
    expect(r!.done).toBe(true);
    expect(r!.totals).toMatchObject({ copied: 3, failed: 0, folders: 3, bytes: 13 + 14 + 9 });
    // Streamed bytes hashed as quickXor (source) and content_hash (destination): both compared.
    expect(r!.totals.verifiedHash).toBe(3);
    expect(text(h.dbx.get("client-a", "/Inbox/Reports/2026/q2.txt")?.content)).toBe("second quarter");
    expect(h.dbx.get("client-a", "/Inbox/Reports/Empty")?.folder).toBe(true);
    // created[] names where each file landed, not where it came from (live test round 4).
    const createdPaths = r!.created.map((c) => c.path).sort();
    expect(createdPaths.length).toBeGreaterThan(0);
    for (const p of createdPaths) expect(p.toLowerCase().startsWith("/inbox/reports/")).toBe(true);

    const again = await runAll({ from: "work:/Reports", to: "client-a:/Inbox" });
    expect(again.at(-1)!.totals).toMatchObject({ copied: 0, skipped: 3, failed: 0, folders: 0 });
  });

  it("resumes mid-tree with maxFiles slices and ends with the same result", async () => {
    const slices = await runAll({ from: "work:/Reports", to: "client-a:/Inbox", maxFiles: 1 });
    expect(slices.length).toBeGreaterThan(3);
    expect(slices.slice(0, -1).every((s) => !s.done && s.cursor)).toBe(true);
    expect(slices.at(-1)!.totals).toMatchObject({ copied: 3, failed: 0 });
    const cur = decodeTransferCursor(slices[0]!.cursor!);
    expect(cur.kind).toBe("cross");
    // One audit entry per slice.
    const audit = (await readAudit(100)).filter((e) => e.tool === "transfer");
    expect(audit).toHaveLength(slices.length);
    expect(audit[0]).toMatchObject({ account: "work", toAccount: "client-a", done: true });
  });

  it("rejects a cursor from a different transfer", async () => {
    const r = await run({ from: "work:/Reports", to: "client-a:/Inbox", maxFiles: 1 });
    await expect(transfer({ from: "work:/Reports/2026", to: "client-a:/Inbox", cursor: r.cursor }, { actor })).rejects.toThrow(/different transfer/);
  });

  it("move trashes the source only once everything verified, on the final slice", async () => {
    const slices = await runAll({ from: "work:/Reports", to: "client-a:/Inbox", move: true, maxFiles: 2 });
    for (const s of slices.slice(0, -1)) expect(s.move).toMatchObject({ trashed: false });
    expect(h.ms.get("work", "/Reports")).toBeUndefined(); // in the recycle bin
    expect(slices.at(-1)!.move).toEqual({ trashed: true });
    const trash = (await readAudit(100)).filter((e) => e.tool === "trash");
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({ account: "work", name: "Reports" });
  });
});

describe("conflicts", () => {
  beforeEach(() => {
    h.dbx.put("client-a", "/Docs/a.txt", "alpha");
    h.dbx.put("client-a", "/Docs/b.txt", "bravo");
    h.ms.put("work", "/Target/Docs/a.txt", "alpha"); // identical: skipped
    h.ms.put("work", "/Target/Docs/b.txt", "something else"); // different: conflict
  });

  it("never overwrites: identical files are skipped, different ones reported", async () => {
    const [r] = await runAll({ from: "client-a:/Docs", to: "work:/Target" });
    expect(r!.totals).toMatchObject({ copied: 0, skipped: 1, failed: 1 });
    expect(r!.failed[0]).toMatchObject({ path: "/Docs/b.txt" });
    expect(r!.failed[0]!.error).toMatch(/different size.*not overwritten/);
    expect(text(h.ms.get("work", "/Target/Docs/b.txt")?.content)).toBe("something else");
  });

  it("move with a failure trashes nothing and says so", async () => {
    const [r] = await runAll({ from: "client-a:/Docs", to: "work:/Target", move: true });
    expect(r!.move?.trashed).toBe(false);
    expect(r!.move?.reason).toMatch(/1 item\(s\) failed.*nothing was trashed/);
    expect(h.dbx.get("client-a", "/Docs/a.txt")).toBeDefined();
    expect((await readAudit(100)).filter((e) => e.tool === "trash")).toHaveLength(0);
  });

  it("refuses to put a folder where a file of that name exists", async () => {
    h.ms.put("work", "/Clash/Docs", "i am a file");
    await expect(run({ from: "client-a:/Docs", to: "work:/Clash" })).rejects.toThrow(/already exists.*not overwritten/);
  });
});

describe("verification", () => {
  it("a destination that stores different bytes fails the file, trashes the bad copy and blocks a move", async () => {
    teardownHarness();
    h = setupHarness({ ms: { corruptUploads: true } });
    h.dbx.put("client-a", "/One/x.bin", "payload");
    h.ms.put("work", "/Dest");
    const [r] = await runAll({ from: "client-a:/One", to: "work:/Dest", move: true });
    expect(r!.totals.failed).toBe(1);
    expect(r!.failed[0]!.error).toMatch(/verification failed.*destination hash does not match/);
    expect(h.ms.get("work", "/Dest/One/x.bin")).toBeUndefined();
    expect(r!.move?.trashed).toBe(false);
    expect(h.dbx.get("client-a", "/One/x.bin")).toBeDefined();
  });
});

describe("chunk boundaries", () => {
  it("Dropbox -> OneDrive: fragments are 320 KiB multiples, sent without Authorization, total fixed", async () => {
    const data = randomBytes(ONEDRIVE_CHUNK * 2 + 5);
    h.dbx.put("client-a", "/big.bin", data);
    h.ms.put("work", "/In");
    const r = await run({ from: "client-a:/big.bin", to: "work:/In" });
    expect(r.done).toBe(true);
    expect(r.totals).toMatchObject({ copied: 1, failed: 0, bytes: data.length, verifiedHash: 1 });
    const puts = h.ms.log.filter((l) => l.url.startsWith("https://upload.fake-1drv.example/") && l.method === "PUT");
    expect(puts.map((p) => p.size)).toEqual([ONEDRIVE_CHUNK, ONEDRIVE_CHUNK, 5]);
    expect(puts.every((p) => !p.auth)).toBe(true);
    expect(puts.map((p) => p.contentRange)).toEqual([
      `bytes 0-${ONEDRIVE_CHUNK - 1}/${data.length}`,
      `bytes ${ONEDRIVE_CHUNK}-${2 * ONEDRIVE_CHUNK - 1}/${data.length}`,
      `bytes ${2 * ONEDRIVE_CHUNK}-${data.length - 1}/${data.length}`,
    ]);
    expect(Buffer.compare(Buffer.from(h.ms.get("work", "/In/big.bin")!.content!), data)).toBe(0);
  });

  it("OneDrive -> Dropbox: a file of exactly one chunk, and an empty file", async () => {
    const data = randomBytes(DROPBOX_CHUNK);
    h.ms.put("work", "/Set/exact.bin", data);
    h.ms.put("work", "/Set/empty.txt", new Uint8Array(0));
    const r = await run({ from: "work:/Set", to: "client-a:/" });
    expect(r.totals).toMatchObject({ copied: 2, failed: 0, bytes: DROPBOX_CHUNK });
    const appends = h.dbx.log.filter((l) => l.route === "upload_session/append_v2");
    expect(appends).toHaveLength(1);
    expect(h.dbx.get("client-a", "/Set/empty.txt")?.content?.length).toBe(0);
  });

  it("a big file that does not fit the slice continues in the next one with a ranged download", async () => {
    const data = randomBytes(ONEDRIVE_CHUNK * 2 + 100);
    h.dbx.put("client-a", "/video.bin", data);
    h.ms.put("work", "/In");
    let t = 0;
    h.setHook((url, init) => {
      if (url.hostname === "upload.fake-1drv.example" && init?.method === "PUT") t = 1e12;
    });
    const first = await run({ from: "client-a:/video.bin", to: "work:/In" }, () => t);
    expect(first.done).toBe(false);
    expect(first.bytes).toBe(ONEDRIVE_CHUNK);
    expect(decodeTransferCursor(first.cursor!)).toMatchObject({ kind: "cross", partial: { offset: ONEDRIVE_CHUNK } });
    h.setHook(undefined);
    t = 0;
    const second = await run({ from: "client-a:/video.bin", to: "work:/In", cursor: first.cursor }, () => t);
    expect(second.done).toBe(true);
    expect(second.totals).toMatchObject({ copied: 1, failed: 0, bytes: data.length });
    expect(h.dbx.log.filter((l) => l.route === "files/download")).toHaveLength(2);
    expect(Buffer.compare(Buffer.from(h.ms.get("work", "/In/video.bin")!.content!), data)).toBe(0);
  });
});

describe("rate limits", () => {
  it("retries 429 with Retry-After on Dropbox and OneDrive", async () => {
    teardownHarness();
    h = setupHarness({ ms: { throttle: 2 }, dbx: { throttle: 1 } });
    h.dbx.put("client-a", "/r.txt", "retry me");
    h.ms.put("work", "/In");
    const r = await run({ from: "client-a:/r.txt", to: "work:/In" });
    expect(r.totals).toMatchObject({ copied: 1, failed: 0 });
    expect(h.sleeps).toEqual([1000, 1000, 1000]);
  });
});

describe("Google sources and destinations", () => {
  it("exports Google Docs to docx when leaving Google and reports the conversion; unexportable types fail", async () => {
    h.drive.files.form = { id: "form", name: "Survey", mimeType: "application/vnd.google-apps.form", parents: ["proj"], owners: [{ emailAddress: "alex@example.com" }] };
    h.ms.put("work", "/In");
    const [r] = await runAll({ from: "personal:/Projects", to: "work:/In" });
    expect(r!.totals).toMatchObject({ copied: 2, failed: 1 });
    expect(r!.notes.join("\n")).toMatch(/exported as docx: "Board notes" -> "Board notes.docx"/);
    expect(text(h.ms.get("work", "/In/Projects/Board notes.docx")?.content)).toBe("PDF(Board notes)");
    expect(text(h.ms.get("work", "/In/Projects/notes.txt")?.content)).toBe("hello notes");
    expect(r!.failed[0]!.error).toMatch(/cannot be exported/);
  });

  it("Dropbox -> Google uploads through a resumable session", async () => {
    h.dbx.put("client-a", "/hello.txt", "hi google");
    const r = await run({ from: "client-a:/hello.txt", to: "backup:/Inbox" });
    expect(r.totals).toMatchObject({ copied: 1, failed: 0 });
    const f = Object.values(h.drive.files).find((x) => x.name === "hello.txt");
    expect(f).toMatchObject({ parents: ["binbox"], content: "hi google" });
  });

  it("Google -> Google is delegated to Drive's server-side copy", async () => {
    const r = await run({ from: "personal:/Projects", to: "backup:/Inbox" });
    expect(r.route).toMatch(/server-side Drive copy/);
    expect(r.done).toBe(true);
    expect(h.drive.log.some((l) => /\/copy$/.test(l.path))).toBe(true);
  });
});

describe("guards and dry run", () => {
  it("dry run counts, totals bytes and lists what will not transfer cleanly, without writing", async () => {
    h.ms.put("work", "/Mixed/a:b.txt", "colon");
    h.ms.put("work", "/Mixed/ok.txt", "fine");
    h.ms.put("work", "/Mixed/Sub/deep.txt", "deep");
    const plan = (await transfer({ from: "work:/Mixed", to: "client-a:/", dryRun: true }, { actor })) as TransferPlan;
    expect(plan).toMatchObject({ dryRun: true, files: 3, folders: 2, bytes: 5 + 4 + 4 });
    expect(plan.issues.map((i) => i.issue).join("\n")).toMatch(/a:b\.txt.*Windows/);
    expect(h.dbx.log.some((l) => /upload|create_folder/.test(l.route))).toBe(false);
  });

  it("dry run towards OneDrive reports renamed and reserved names and Google exports", async () => {
    h.drive.files.bad = { id: "bad", name: 'what?.txt', mimeType: "text/plain", parents: ["proj"], owners: [{ emailAddress: "alex@example.com" }], size: "1", content: "x" };
    h.drive.files.con = { id: "con", name: "CON.txt", mimeType: "text/plain", parents: ["proj"], owners: [{ emailAddress: "alex@example.com" }], size: "1", content: "x" };
    h.ms.put("work", "/In");
    const plan = (await transfer({ from: "personal:/Projects", to: "work:/In", dryRun: true }, { actor })) as TransferPlan;
    const issues = plan.issues.map((i) => i.issue).join("\n");
    expect(issues).toMatch(/renamed "what\?\.txt" -> "what_\.txt"/);
    expect(issues).toMatch(/renamed "CON\.txt" -> "CON_\.txt" \(reserved name on OneDrive\)/);
    expect(issues).toMatch(/exported as docx/);
    expect(plan.exports).toBe(1);
  });

  it("refuses writes to an account connected read-only", async () => {
    h.dbx.put("client-a", "/r.txt", "x");
    await expect(run({ from: "client-a:/r.txt", to: "archive:/" })).rejects.toThrow(/read-only/);
  });

  it("refuses to transfer a folder into itself", async () => {
    h.ms.put("work", "/Loop/Inner");
    await expect(run({ from: "work:/Loop", to: "work:/Loop/Inner" })).rejects.toThrow(/into itself/);
  });
});
