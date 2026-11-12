/**
 * MCP tools for every provider (Google Drive, OneDrive, Dropbox):
 * read  — cloud_list, cloud_find, cloud_read
 * write — cloud_mkdir, cloud_move, cloud_rename, cloud_trash, transfer
 *
 * Wiring (tools.ts, after the merge): call `registerProviderReadTools(server)`
 * at the end of `registerReadTools` and `registerProviderWriteTools(server)`
 * at the end of `registerWriteTools`, or `registerProviderTools(server, { full })`
 * once from each handler. Read-only tokens get the read tools only; accounts
 * whose `mode` is "read" are refused by every write tool server-side. Every
 * write appends an audit entry.
 */
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { appendAudit } from "../audit";
import { checkName } from "../ctx";
import { actorOf } from "../oauth";
import { pickReader } from "../readers";
import { getAccount, loadAccounts } from "../store";
import { wrap } from "../toolkit";
import { LABEL_RE } from "./env";
import { assertWriteMode, parseRef, providerFor, providerForAccount, PROVIDER_NAMES } from "./index";
import { DEFAULT_TRANSFER_MAX_FILES, DRY_RUN_CAP, transfer } from "./transfer";
import type { Entry, StorageProvider } from "./types";

export const MAX_CLOUD_READ_BYTES = 2 * 1024 * 1024;

export interface ProviderToolDeps {
  /** True for the full-access server: write tools are registered too. */
  full: boolean;
  /** Who is acting, for the audit log. Defaults to the OAuth identity (actorOf). */
  actor?: (ctx: ServerContext) => string;
}

const accountArg = z.string().regex(LABEL_RE).describe("Account label");
const refArg = z
  .string()
  .min(1)
  .describe("label:/path, e.g. personal:/Projects/Report.pdf (label:/ is the account root). Works for Google, OneDrive and Dropbox accounts.");

const itemSchema = {
  path: refArg.optional(),
  account: accountArg.optional().describe("With id: the account that holds the item"),
  id: z.string().min(1).optional().describe("Provider item id (alternative to path)"),
};

function show(label: string, e: Entry) {
  return {
    name: e.name,
    path: `${label}:${e.path}`,
    id: e.id,
    isFolder: e.isFolder,
    size: e.size,
    modified: e.modified,
    hash: e.hash,
    mimeType: e.mimeType,
    ...(e.googleNative ? { googleNative: true } : {}),
    ...(e.shortcut ? { shortcut: true } : {}),
  };
}

async function resolveItem(a: { path?: string; account?: string; id?: string }): Promise<{ label: string; provider: StorageProvider; entry: Entry; account: Awaited<ReturnType<typeof getAccount>> }> {
  if (a.path) {
    const ref = parseRef(a.path);
    const { account, provider } = await providerFor(ref.label);
    return { label: ref.label, provider, account, entry: await provider.stat(ref.path) };
  }
  if (a.account && a.id) {
    const { account, provider } = await providerFor(a.account);
    return { label: a.account, provider, account, entry: await provider.statId(a.id) };
  }
  throw new Error("Give path (label:/...) or account + id");
}

const defaultActor = (ctx: ServerContext) => actorOf(ctx.http?.authInfo);

export function registerProviderReadTools(server: McpServer) {
  server.registerTool(
    "cloud_list",
    {
      title: "List a folder (any provider)",
      description:
        "List one page of a folder on any connected account (Google Drive, OneDrive, Dropbox), folders and files with size, modified time and content hash. " +
        "Pass nextPageToken back as pageToken for the next page. Use this (not list) for OneDrive and Dropbox accounts.",
      inputSchema: z.object({ path: refArg, pageToken: z.string().optional() }),
      annotations: { readOnlyHint: true },
    },
    wrap(async (a: { path: string; pageToken?: string }) => {
      const ref = parseRef(a.path);
      const { provider } = await providerFor(ref.label);
      const folder = await provider.stat(ref.path);
      if (!folder.isFolder) return { account: ref.label, provider: PROVIDER_NAMES[provider.kind], item: show(ref.label, folder) };
      const page = await provider.list(folder, a.pageToken);
      return {
        account: ref.label,
        provider: PROVIDER_NAMES[provider.kind],
        folder: `${ref.label}:${folder.path}`,
        entries: page.entries.map((e) => show(ref.label, e)),
        nextPageToken: page.nextPageToken,
      };
    }),
  );

  server.registerTool(
    "cloud_find",
    {
      title: "Find files (any provider)",
      description: "Search file and folder names (and content where the provider supports it) on one account or on every connected account; optionally below path.",
      inputSchema: z.object({
        query: z.string().min(1),
        account: accountArg.optional().describe("Account label; omit for all accounts"),
        path: refArg.optional().describe("Only below this folder (implies its account)"),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    wrap(async (a: { query: string; account?: string; path?: string; limit: number }) => {
      if (a.path) {
        const ref = parseRef(a.path);
        const { provider } = await providerFor(ref.label);
        const under = await provider.stat(ref.path);
        return { results: (await provider.find(a.query, a.limit, under)).map((e) => show(ref.label, e)) };
      }
      const accounts = a.account ? [await getAccount(a.account)] : await loadAccounts();
      const results: ReturnType<typeof show>[] = [];
      const errors: { account: string; error: string }[] = [];
      await Promise.all(
        accounts.map(async (acc) => {
          try {
            const hits = await providerForAccount(acc).find(a.query, a.limit);
            results.push(...hits.map((e) => show(acc.label, e)));
          } catch (e) {
            errors.push({ account: acc.label, error: e instanceof Error ? e.message : String(e) });
          }
        }),
      );
      results.sort((x, y) => (y.modified ?? "").localeCompare(x.modified ?? ""));
      return { results: results.slice(0, a.limit), ...(errors.length ? { errors } : {}) };
    }),
  );

  server.registerTool(
    "cloud_read",
    {
      title: "Read a text file (any provider)",
      description: `Read a plain-text file (txt, md, csv, json, ...) from any connected account, up to maxBytes (default 256 KB, max ${MAX_CLOUD_READ_BYTES / 1024 / 1024} MB). ` +
        "Other formats: transfer them to a Google account and use read there.",
      inputSchema: z.object({ ...itemSchema, maxBytes: z.number().int().min(1).max(MAX_CLOUD_READ_BYTES).default(256 * 1024) }),
      annotations: { readOnlyHint: true },
    },
    wrap(async (a: { path?: string; account?: string; id?: string; maxBytes: number }) => {
      const { label, provider, entry } = await resolveItem(a);
      if (entry.isFolder) throw new Error(`${label}:${entry.path} is a folder; use cloud_list`);
      if (entry.googleNative || pickReader(entry.mimeType, entry.name) !== "text") {
        throw new Error(`cloud_read reads plain-text files only; ${entry.name} is not one${provider.kind === "google" ? " (use read for Google accounts)" : ""}`);
      }
      const dl = await provider.download(entry);
      const parts: Buffer[] = [];
      let got = 0;
      let truncated = false;
      for await (const piece of dl.stream) {
        const take = Math.min(piece.length, a.maxBytes - got);
        parts.push(Buffer.from(piece.subarray(0, take)));
        got += take;
        if (got >= a.maxBytes) {
          truncated = (entry.size ?? Infinity) > got || take < piece.length;
          break;
        }
      }
      return { ...show(label, entry), text: Buffer.concat(parts).toString("utf8"), bytesRead: got, truncated };
    }),
  );
}

export function registerProviderWriteTools(server: McpServer, deps: Pick<ProviderToolDeps, "actor"> = {}) {
  const actorFor = deps.actor ?? defaultActor;

  server.registerTool(
    "cloud_mkdir",
    {
      title: "Create folder (any provider)",
      description: "Create a folder at label:/A/B/New, creating missing parents. Idempotent: existing folders are reused.",
      inputSchema: z.object({ path: refArg }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    wrap(async (a: { path: string }, ctx) => {
      const ref = parseRef(a.path);
      const { account, provider } = await providerFor(ref.label);
      await assertWriteMode(account);
      let cur = await provider.root();
      const created: string[] = [];
      for (const seg of ref.path.split("/").filter(Boolean)) {
        const existing = await provider.child(cur, seg);
        if (existing && !existing.isFolder) throw new Error(`${ref.label}:${existing.path} is a file, not a folder`);
        if (existing) {
          cur = existing;
          continue;
        }
        cur = await provider.mkdir(cur, seg);
        created.push(cur.path);
        await appendAudit({ tool: "cloud_mkdir", account: ref.label, fileId: cur.id, name: cur.name, to: cur.path, actor: actorFor(ctx) });
      }
      return { ...show(ref.label, cur), created: created.map((p) => `${ref.label}:${p}`) };
    }),
  );

  server.registerTool(
    "cloud_move",
    {
      title: "Move within an account (any provider)",
      description: "Move a file or folder to another folder of the SAME account. Never overwrites (a name clash is an error). Across accounts use transfer with move=true.",
      inputSchema: z.object({ ...itemSchema, toFolder: refArg.describe("Destination folder, label:/path in the same account") }),
      annotations: { destructiveHint: false },
    },
    wrap(async (a: { path?: string; account?: string; id?: string; toFolder: string }, ctx) => {
      const { label, provider, entry, account } = await resolveItem(a);
      await assertWriteMode(account);
      const to = parseRef(a.toFolder);
      if (to.label !== label) throw new Error(`toFolder is in account "${to.label}" but the item is in "${label}"; use transfer (move=true) across accounts`);
      const folder = await provider.stat(to.path);
      if (!folder.isFolder) throw new Error(`${a.toFolder} is not a folder`);
      if (entry.isFolder && (folder.path === entry.path || folder.path.startsWith(`${entry.path}/`))) throw new Error("Cannot move a folder into itself");
      const moved = await provider.move(entry, folder);
      await appendAudit({ tool: "cloud_move", account: label, fileId: entry.id, name: entry.name, from: entry.path, to: folder.path, actor: actorFor(ctx) });
      return show(label, moved);
    }),
  );

  server.registerTool(
    "cloud_rename",
    {
      title: "Rename (any provider)",
      description: "Rename a file or folder in place; the naming rule applies to files unless allowNonStandardName. Never overwrites.",
      inputSchema: z.object({ ...itemSchema, newName: z.string().min(1).max(255), allowNonStandardName: z.boolean().default(false) }),
      annotations: { destructiveHint: false },
    },
    wrap(async (a: { path?: string; account?: string; id?: string; newName: string; allowNonStandardName: boolean }, ctx) => {
      if (/[/\\]/.test(a.newName)) throw new Error("newName must not contain / or \\");
      const { label, provider, entry, account } = await resolveItem(a);
      await assertWriteMode(account);
      if (!entry.isFolder) checkName(a.newName, entry.mimeType, a.allowNonStandardName);
      const renamed = await provider.rename(entry, a.newName);
      await appendAudit({ tool: "cloud_rename", account: label, fileId: entry.id, name: a.newName, from: entry.name, actor: actorFor(ctx) });
      return show(label, renamed);
    }),
  );

  server.registerTool(
    "cloud_trash",
    {
      title: "Trash (any provider)",
      description:
        "Move a file or folder to the provider's recoverable trash: Google Drive trash, OneDrive recycle bin, Dropbox deleted files. Nothing is permanently deleted.",
      inputSchema: z.object(itemSchema),
      annotations: { destructiveHint: true },
    },
    wrap(async (a: { path?: string; account?: string; id?: string }, ctx) => {
      const { label, provider, entry, account } = await resolveItem(a);
      await assertWriteMode(account);
      await provider.trash(entry);
      await appendAudit({ tool: "cloud_trash", account: label, fileId: entry.id, name: entry.name, from: entry.path, actor: actorFor(ctx) });
      return { trashed: true, ...show(label, entry) };
    }),
  );

  server.registerTool(
    "transfer",
    {
      title: "Copy or move between any two accounts (BETA)",
      description:
        "Copy (or move) a file or a whole folder tree from one connected account to another, across providers: Google Drive, OneDrive (personal and work/school), Dropbox. " +
        "dryRun defaults to TRUE: it walks the source and returns files/folders/bytes plus everything that will not transfer cleanly " +
        `(Google Docs/Sheets/Slides exported to docx/xlsx/pptx, names illegal on the target and how they are renamed, size and path limits), walk capped at ${DRY_RUN_CAP} items. ` +
        `With dryRun=false the work happens in slices (up to maxFiles items, default ${DEFAULT_TRANSFER_MAX_FILES}, or ~4 minutes): repeat the call with the same from/to/move plus the returned cursor until done=true. ` +
        "Every file is verified (size, and content hash where comparable). Existing destination items are never overwritten: identical ones are skipped, different ones reported. " +
        "move=true trashes the source (recoverably) only on the final slice and only if every item verified. " +
        "Google to Google: a writable source uses Drive's server-side copy through a temporary per-file reader grant (removed after each file, audited); " +
        "a read-only source (or a file only writers may copy) is streamed and never modified, with Docs/Sheets/Slides exported and imported back and Forms and similar listed in notCopied.",
      inputSchema: z.object({
        from: refArg.describe("Source file or folder, label:/path"),
        to: refArg.describe("Destination folder, label:/path (must exist; the item keeps its name inside it)"),
        move: z.boolean().default(false),
        dryRun: z.boolean().default(true),
        cursor: z.string().optional().describe("Resume cursor from the previous call"),
        maxFiles: z.number().int().min(1).max(1000).default(DEFAULT_TRANSFER_MAX_FILES),
      }),
      annotations: { destructiveHint: false },
    },
    wrap(async (a: { from: string; to: string; move: boolean; dryRun: boolean; cursor?: string; maxFiles: number }, ctx) =>
      transfer({ ...a, dryRun: a.cursor ? false : a.dryRun }, { actor: actorFor(ctx) }),
    ),
  );
}

/** Registers the read tools always and the write tools when `deps.full`. */
export function registerProviderTools(server: McpServer, deps: ProviderToolDeps) {
  registerProviderReadTools(server);
  if (deps.full) registerProviderWriteTools(server, deps);
}
