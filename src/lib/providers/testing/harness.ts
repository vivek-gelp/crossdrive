/**
 * Shared test setup for the provider tests: a mixed set of connected
 * accounts (Google via testing/fakeDrive, OneDrive and Dropbox via the fakes
 * here), a store mock that knows providers and modes, and the fetch / sleep
 * seams wired together.
 *
 *   personal  google     alex@example.com
 *   backup    google     backup@example.com
 *   work      microsoft  work@example.com
 *   archive   microsoft  archive@example.com   (mode: read)
 *   client-a  dropbox    client-a@example.com
 *   client-b  dropbox    client-b@example.com
 */
import { createHash } from "node:crypto";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { setDriveFetch } from "../../ctx";
import { FOLDER_MIME } from "../../drive";
import { setStore } from "../../store";
import { fakeDrive, memoryStore, type FakeDrive, type FakeFile } from "../../testing/fakeDrive";
import { setProviderFetch, setProviderSleep } from "../env";
import { clearProviderTokens } from "../tokens";
import { fakeDropbox, type FakeDropbox } from "./fakeDropbox";
import { fakeOneDrive, type FakeOneDrive, type FakeMsOpts } from "./fakeOneDrive";
import type { FakeDbxOpts } from "./fakeDropbox";

export { ACCOUNTS, providerStoreMock, upserts } from "./storeMock";
import { upserts } from "./storeMock";

export const GDOC = "application/vnd.google-apps.document";
export const GFORM = "application/vnd.google-apps.form";

/**
 * personal:/Projects
 *   notes.txt ("hello notes")
 *   Board notes (Google Doc)
 *   Survey (Google Form: not exportable)
 * backup:/Inbox
 */
export function googleFiles(): Record<string, FakeFile> {
  const own = [{ emailAddress: "alex@example.com" }];
  const bk = [{ emailAddress: "backup@example.com" }];
  return {
    root: { id: "root", name: "My Drive", mimeType: FOLDER_MIME, owners: own },
    proj: { id: "proj", name: "Projects", mimeType: FOLDER_MIME, parents: ["root"], owners: own },
    notes: { id: "notes", name: "notes.txt", mimeType: "text/plain", parents: ["proj"], owners: own, size: "11", content: "hello notes", md5Checksum: createHash("md5").update("hello notes").digest("hex") },
    gdoc: { id: "gdoc", name: "Board notes", mimeType: GDOC, parents: ["proj"], owners: own },
    broot: { id: "broot", name: "My Drive", mimeType: FOLDER_MIME, owners: bk },
    binbox: { id: "binbox", name: "Inbox", mimeType: FOLDER_MIME, parents: ["broot"], owners: bk },
  };
}

export interface Harness {
  drive: FakeDrive;
  ms: FakeOneDrive;
  dbx: FakeDropbox;
  sleeps: number[];
  /** Calls through the combined fetch (for wrapping in tests). */
  setHook(h: ((url: URL, init?: RequestInit) => void) | undefined): void;
}

export function setupHarness(opts: { googleFiles?: Record<string, FakeFile>; ms?: FakeMsOpts; dbx?: FakeDbxOpts } = {}): Harness {
  process.env.MS_CLIENT_ID = "ms-client";
  process.env.MS_CLIENT_SECRET = "ms-secret";
  process.env.DROPBOX_CLIENT_ID = "dbx-client";
  process.env.DROPBOX_CLIENT_SECRET = "dbx-secret";
  process.env.VAULT_JWT_SECRET = Buffer.alloc(32, 7).toString("base64");
  setStore(memoryStore());
  clearProviderTokens();
  upserts.length = 0;
  const drive = fakeDrive(
    [
      { label: "personal", email: "alex@example.com" },
      { label: "backup", email: "backup@example.com" },
    ],
    opts.googleFiles ?? googleFiles(),
  );
  const ms = fakeOneDrive(["work", "archive"], opts.ms);
  const dbx = fakeDropbox(["client-a", "client-b"], opts.dbx);
  const sleeps: number[] = [];
  let hook: ((url: URL, init?: RequestInit) => void) | undefined;
  setDriveFetch(drive.fetchImpl);
  setProviderSleep(async (ms) => void sleeps.push(ms));
  setProviderFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = /dropbox/.test(url.hostname) ? await dbx.fetchImpl(input, init) : await ms.fetchImpl(input, init);
    hook?.(url, init);
    return res;
  }) as typeof fetch);
  return { drive, ms, dbx, sleeps, setHook: (h) => void (hook = h) };
}

export function teardownHarness() {
  setProviderFetch(undefined);
  setProviderSleep(undefined);
  setDriveFetch(undefined);
  setStore(undefined);
}

// ---- tool harness --------------------------------------------------------------

export type Handler = (args: Record<string, unknown>, ctx: ServerContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;

export function collect(register: (server: McpServer) => void): Record<string, Handler> {
  const tools: Record<string, Handler> = {};
  const server = { registerTool: (name: string, _d: unknown, h: Handler) => void (tools[name] = h) } as unknown as McpServer;
  register(server);
  return tools;
}

export async function call(tools: Record<string, Handler>, name: string, args: Record<string, unknown>) {
  const r = await tools[name]!(args, {} as ServerContext);
  const t = r.content[0]?.text ?? "";
  return { isError: r.isError === true, text: t, json: r.isError ? undefined : (JSON.parse(t) as Record<string, unknown>) };
}
