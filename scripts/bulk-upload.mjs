#!/usr/bin/env node
/**
 * Bulk upload a local folder tree into a Crossdrive drive. Plain Node 20+,
 * no build step, no dependencies beyond fetch/fs.
 *
 *   node scripts/bulk-upload.mjs --src "C:\path\to\folder" --dest "work:/Projects/Current/X"
 *        [--url https://your-deployment.example.com] [--dry-run] [--concurrency 3]
 *        [--include "*.pdf,*.xlsx"] [--exclude "node_modules,*.tmp"] [--manifest out.csv] [--allow-nonstandard-names]
 *
 * Server: --url or CROSSDRIVE_URL (required; there is no default). Auth: CROSSDRIVE_TOKEN
 * (one of the server's CROSSDRIVE_STATIC_TOKENS; `vercel env pull` writes them to
 * .env.local, or paste the value). Legacy VAULT_URL / VAULT_TOKEN are still accepted.
 *
 * Folders are mirrored with `mkdir` (idempotent), files already present with
 * the same name and size are skipped (`list`), everything else goes through
 * `upload_begin` + chunked PUTs straight to Google (8 MiB chunks, retry and
 * resume on 308 / network errors) + `upload_finish`. Bytes never pass through
 * the Crossdrive server. A manifest CSV lists every file with its outcome.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  chunkRanges,
  drivePathFor,
  envValue,
  manifestCsv,
  mimeTypeFor,
  nextOffset,
  parseArgs,
  parseDest,
  parseRpcBody,
  parseToolResult,
  resolveServerUrl,
  shouldInclude,
  shouldSkip,
  summarize,
  USAGE,
} from "./lib/bulk.mjs";

const MAX_ATTEMPTS = 6;

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

// ---- MCP client (Streamable HTTP) ------------------------------------------

class CrossdriveClient {
  constructor(baseUrl, token) {
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/api/mcp`;
    this.token = token;
    this.sessionId = undefined;
    this.id = 0;
  }

  async rpc(method, params, { notification = false } = {}) {
    const id = notification ? undefined : ++this.id;
    const headers = { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const res = await fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (notification) {
      if (!res.ok && res.status !== 202) throw new Error(`${method}: HTTP ${res.status}`);
      return undefined;
    }
    const body = await res.text();
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${body.slice(0, 300)}`);
    const msgs = parseRpcBody(res.headers.get("content-type") ?? "", body);
    const reply = msgs.find((m) => m.id === id) ?? msgs[msgs.length - 1];
    if (!reply) throw new Error(`${method}: empty response`);
    return reply;
  }

  async init() {
    const r = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "crossdrive-bulk-upload", version: "1.0.0" } });
    if (r.error) throw new Error(`initialize: ${r.error.message}`);
    await this.rpc("notifications/initialized", {}, { notification: true }).catch(() => undefined);
    return r.result;
  }

  async call(name, args) {
    return parseToolResult(await this.rpc("tools/call", { name, arguments: args }));
  }
}

// ---- local walk ------------------------------------------------------------

async function walk(root, filters) {
  const dirs = [];
  const files = [];
  const visit = async (dir, rel) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!shouldInclude(r, { exclude: filters.exclude })) continue;
        dirs.push(r);
        await visit(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (!shouldInclude(r, filters)) continue;
        const st = await fsp.stat(path.join(dir, e.name));
        files.push({ abs: path.join(dir, e.name), rel: r, dir: rel, name: e.name, size: st.size });
      }
    }
  };
  await visit(root, "");
  return { dirs, files };
}

// ---- upload of one file ----------------------------------------------------

/** Read bytes [start, end] of a file into memory (one chunk at a time, 8 MiB at most). */
async function readChunk(abs, start, end) {
  const length = end - start + 1;
  const buf = Buffer.alloc(length);
  const h = await fsp.open(abs, "r");
  try {
    let got = 0;
    while (got < length) {
      const { bytesRead } = await h.read(buf, got, length - got, start + got);
      if (bytesRead === 0) throw new Error(`file shrank while uploading (${abs})`);
      got += bytesRead;
    }
  } finally {
    await h.close();
  }
  return buf;
}

async function putRange(uploadUrl, abs, start, end, size) {
  const length = end - start + 1;
  const body = length > 0 ? await readChunk(abs, start, end) : undefined;
  return fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Range": length > 0 ? `bytes ${start}-${end}/${size}` : `bytes */${size}` },
    body,
    redirect: "manual",
  });
}

async function queryOffset(uploadUrl, size) {
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Range": `bytes */${size}` }, redirect: "manual" });
  if (res.status === 308) return nextOffset(res.headers.get("range"));
  if (res.ok) return size;
  throw new Error(`status query answered ${res.status}`);
}

/** PUT the file to the session in chunks; resumes from Google's reported offset after any failure. */
async function uploadFile(uploadUrl, f) {
  let offset = 0;
  let attempt = 0;
  for (;;) {
    try {
      const ranges = chunkRanges(f.size).filter(([, end]) => end >= offset || f.size === 0);
      for (const [start0, end] of ranges) {
        const start = Math.max(start0, offset);
        const res = await putRange(uploadUrl, f.abs, start, end, f.size);
        if (res.status === 308) {
          offset = nextOffset(res.headers.get("range"));
          if (offset !== end + 1) throw new Error(`Google acknowledged ${offset} bytes, expected ${end + 1}`);
          continue;
        }
        if (res.ok) return await res.json();
        const text = await res.text().catch(() => "");
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
        throw Object.assign(new Error(`HTTP ${res.status} ${text.slice(0, 200)}`), { fatal: true });
      }
      throw new Error("ran out of chunks before Google finished the file");
    } catch (e) {
      if (e.fatal || ++attempt >= MAX_ATTEMPTS) throw e;
      await sleep(Math.min(1000 * 2 ** attempt, 30_000));
      offset = await queryOffset(uploadUrl, f.size).catch(() => offset);
      if (offset >= f.size && f.size > 0) {
        // Everything arrived; one more empty PUT returns the file.
        const res = await putRange(uploadUrl, f.abs, 0, -1, f.size);
        if (res.ok) return await res.json();
      }
    }
  }
}

// ---- main ------------------------------------------------------------------

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const dest = parseDest(args.dest);
  const src = path.resolve(args.src);
  if (!fs.statSync(src, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`--src ${src} is not a directory`);
    process.exit(2);
  }
  const { dirs, files } = await walk(src, { include: args.include, exclude: args.exclude });
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  log(`${files.length} files (${mb(totalBytes)}) in ${dirs.length + 1} folders under ${src}`);
  log(`-> ${dest.path}${args.dryRun ? " (dry run: nothing is uploaded)" : ""}`);

  const rows = [];
  const manifestPath = args.manifest ? path.resolve(args.manifest) : "";
  const writeManifest = () => manifestPath && fs.writeFileSync(manifestPath, manifestCsv(rows));

  if (args.dryRun) {
    for (const d of dirs) log(`  mkdir ${drivePathFor(dest.path, d)}`);
    for (const f of files) {
      rows.push({ localPath: f.abs, drivePath: drivePathFor(dest.path, f.rel), fileId: "", status: "planned", bytes: f.size, message: mimeTypeFor(f.name) });
      log(`  put   ${drivePathFor(dest.path, f.rel)} (${mb(f.size)})`);
    }
    const s = summarize(rows);
    log(`Plan: ${s.planned} files, ${mb(s.bytesPlanned)}, ${dirs.length} folders to create. Skips are decided against the drive at run time.`);
    writeManifest();
    if (manifestPath) log(`Manifest: ${manifestPath}`);
    return;
  }

  let serverUrl;
  try {
    serverUrl = resolveServerUrl(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const token = envValue("TOKEN");
  if (!token) {
    console.error(`CROSSDRIVE_TOKEN is not set (a CROSSDRIVE_STATIC_TOKENS value; run "vercel env pull" in your Crossdrive clone and copy it from .env.local, or paste it).\n${USAGE}`);
    process.exit(2);
  }
  const client = new CrossdriveClient(serverUrl, token);
  await client.init();

  // Mirror folders: the destination itself, then every local subfolder (parents first).
  const top = await client.call("mkdir", { account: dest.account, parentPath: dest.parentPath, name: dest.name });
  log(`${top.created ? "created" : "found"} ${top.path} (${top.id})`);
  const folderIds = new Map([["", top.id]]);
  for (const d of dirs) {
    const parentRel = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
    const r = await client.call("mkdir", { account: dest.account, parentId: folderIds.get(parentRel), name: path.basename(d) });
    folderIds.set(d, r.id);
    if (r.created) log(`created ${r.path}`);
  }

  // Existing files per folder, for the skip decision.
  const remote = new Map();
  for (const [rel, id] of folderIds) {
    const byName = new Map();
    let pageToken;
    do {
      const page = await client.call("list", { account: dest.account, folderId: id, ...(pageToken ? { pageToken } : {}) });
      for (const f of page.files) byName.set(f.name, { id: f.id, size: f.size, mimeType: f.mimeType });
      pageToken = page.nextPageToken;
    } while (pageToken);
    remote.set(rel, byName);
  }

  let done = 0;
  let doneBytes = 0;
  const queue = [...files];
  const worker = async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      const drivePath = drivePathFor(dest.path, f.rel);
      const row = { localPath: f.abs, drivePath, fileId: "", status: "", bytes: f.size, message: "" };
      rows.push(row);
      const existing = remote.get(f.dir);
      if (shouldSkip({ name: f.name, size: f.size }, existing)) {
        row.status = "skipped";
        row.fileId = existing.get(f.name).id;
        row.message = "same name and size at destination";
      } else {
        try {
          const begin = await client.call("upload_begin", { account: dest.account, folderId: folderIds.get(f.dir), name: f.name, mimeType: mimeTypeFor(f.name), size: f.size, allowNonStandardName: args.allowNonstandardNames });
          const file = await uploadFile(begin.uploadUrl, f);
          const fin = await client.call("upload_finish", { account: dest.account, fileId: file.id });
          row.status = "uploaded";
          row.fileId = fin.id;
          row.message = fin.webViewLink ?? "";
          doneBytes += f.size;
        } catch (e) {
          row.status = "error";
          row.message = e.message;
        }
      }
      done++;
      log(`[${done}/${files.length}] ${row.status.padEnd(8)} ${drivePath}${row.status === "error" ? `  (${row.message})` : ""}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(args.concurrency, files.length || 1) }, worker));
  } finally {
    writeManifest();
  }
  const s = summarize(rows);
  log(`Done: ${s.uploaded} uploaded (${mb(doneBytes)}), ${s.skipped} skipped, ${s.error} failed.`);
  if (manifestPath) log(`Manifest: ${manifestPath}`);
  if (s.error) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
