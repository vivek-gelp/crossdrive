/**
 * Pure helpers for scripts/bulk-upload.mjs: argument parsing, include/exclude
 * matching, skip decisions, chunk ranges, resume offsets and the manifest
 * CSV. No I/O here so they can be unit-tested (scripts/lib/bulk.test.mjs).
 */

export const CHUNK_BYTES = 8 * 1024 * 1024;

export const USAGE = `Usage: node scripts/bulk-upload.mjs --src "C:\\path\\to\\folder" --dest "work:/Projects/Current/X"
         [--url https://your-deployment.example.com] [--dry-run] [--concurrency 3] [--include "*.pdf,*.xlsx"]
         [--exclude "node_modules,*.tmp"] [--manifest out.csv] [--allow-nonstandard-names]
Env: CROSSDRIVE_URL (your deployment's base URL; required unless --url is given) and CROSSDRIVE_TOKEN
(a CROSSDRIVE_STATIC_TOKENS value). The legacy VAULT_URL / VAULT_TOKEN names are still accepted.`;

/** CROSSDRIVE_<name>, else the legacy VAULT_<name>; empty strings count as unset (same rule as the server's env()). */
export function envValue(name, env = process.env) {
  for (const key of [`CROSSDRIVE_${name}`, `VAULT_${name}`]) {
    const v = env[key];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * Server URL from --url, else CROSSDRIVE_URL / VAULT_URL. There is no default: the script must never talk to a
 * deployment the user did not name. Throws with the usage text when none is given.
 */
export function resolveServerUrl(args, env = process.env) {
  const url = (args.url || envValue("URL", env) || "").trim();
  if (!url) throw new Error(`No server URL: pass --url or set CROSSDRIVE_URL to your deployment's base URL.\n${USAGE}`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Server URL "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error(`Server URL must use https (or be localhost): ${url}`);
  }
  return url.replace(/\/$/, "");
}

/** Parse `process.argv.slice(2)`. Throws with a usage message on bad input. */
export function parseArgs(argv) {
  const out = { src: "", dest: "", dryRun: false, concurrency: 3, include: [], exclude: [], manifest: "", allowNonstandardNames: false };
  const list = (v) =>
    String(v)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    switch (a) {
      case "--src":
        out.src = next();
        break;
      case "--dest":
        out.dest = next();
        break;
      case "--url":
        out.url = next();
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--concurrency": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error("--concurrency must be an integer between 1 and 16");
        out.concurrency = n;
        break;
      }
      case "--include":
        out.include.push(...list(next()));
        break;
      case "--exclude":
        out.exclude.push(...list(next()));
        break;
      case "--manifest":
        out.manifest = next();
        break;
      case "--allow-nonstandard-names":
        out.allowNonstandardNames = true;
        break;
      case "--help":
      case "-h":
        throw new Error(USAGE);
      default:
        throw new Error(`Unknown argument ${a}\n${USAGE}`);
    }
  }
  if (!out.src || !out.dest) throw new Error(`--src and --dest are required\n${USAGE}`);
  return out;
}

/** `label:/A/B` -> { account, path, parentPath, name }. */
export function parseDest(dest) {
  const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(dest.trim());
  if (!m) throw new Error(`--dest must look like label:/Folder/Sub (got ${dest})`);
  const account = m[1];
  const segments = m[2]
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) throw new Error("--dest must name a folder below the root, e.g. work:/Inbox");
  const name = segments[segments.length - 1];
  const head = segments.slice(0, -1);
  const first = head[0]?.toLowerCase();
  const special = first === "~shared" || first === "drive";
  const parentPath = `${account}:${special ? "" : "/"}${head.join("/")}`;
  return { account, path: `${account}:${special ? "" : "/"}${segments.join("/")}`, parentPath, name };
}

/** Glob with `*` and `?` only, matched against a whole name (case-insensitive). */
export function globToRegExp(pattern) {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/**
 * Keep a file when no --exclude pattern matches any of its path segments
 * (so "node_modules" prunes a directory and "*.tmp" prunes files) and, when
 * --include is given, at least one include pattern matches its basename.
 */
export function shouldInclude(relPath, { include = [], exclude = [] } = {}) {
  const segments = relPath.split(/[\\/]+/).filter(Boolean);
  const base = segments[segments.length - 1] ?? "";
  if (exclude.some((p) => segments.some((s) => globToRegExp(p).test(s)))) return false;
  if (include.length === 0) return true;
  return include.some((p) => globToRegExp(p).test(base));
}

/** True when the destination already holds a file of the same name and byte size. */
export function shouldSkip(local, remoteByName) {
  const r = remoteByName.get(local.name);
  if (!r) return false;
  if (r.mimeType === "application/vnd.google-apps.folder") return false;
  return r.size === undefined || r.size === local.size;
}

/** [start, end] byte ranges (inclusive) of `chunkBytes` pieces; a 0-byte file has one empty range. */
export function chunkRanges(size, chunkBytes = CHUNK_BYTES) {
  if (chunkBytes % (256 * 1024) !== 0) throw new Error("chunkBytes must be a multiple of 256 KiB");
  if (size === 0) return [[0, -1]];
  const out = [];
  for (let start = 0; start < size; start += chunkBytes) out.push([start, Math.min(start + chunkBytes, size) - 1]);
  return out;
}

/** Next byte to send after a 308: `Range: bytes=0-N` means N+1 bytes arrived; no header means none did. */
export function nextOffset(rangeHeader) {
  if (!rangeHeader) return 0;
  const m = /bytes=0-(\d+)/.exec(rangeHeader);
  return m ? Number(m[1]) + 1 : 0;
}

const MIME = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  zip: "application/zip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  dwg: "application/acad",
  kml: "application/vnd.google-earth.kml+xml",
  kmz: "application/vnd.google-earth.kmz",
};

export function mimeTypeFor(name) {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return (ext && MIME[ext]) || "application/octet-stream";
}

export function csvEscape(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const MANIFEST_COLUMNS = ["localPath", "drivePath", "fileId", "status", "bytes", "message"];

/** CSV text (CRLF, header first) for manifest rows {localPath, drivePath, fileId, status, bytes, message}. */
export function manifestCsv(rows) {
  const lines = [MANIFEST_COLUMNS.join(",")];
  for (const r of rows) lines.push(MANIFEST_COLUMNS.map((c) => csvEscape(r[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Totals by status plus byte counts, for the summary line. */
export function summarize(rows) {
  const out = { uploaded: 0, skipped: 0, error: 0, planned: 0, bytesUploaded: 0, bytesPlanned: 0 };
  for (const r of rows) {
    if (r.status in out) out[r.status]++;
    if (r.status === "uploaded") out.bytesUploaded += r.bytes ?? 0;
    if (r.status === "planned") out.bytesPlanned += r.bytes ?? 0;
  }
  return out;
}

/** Drive path of a local relative path below `destPath` (forward slashes, no trailing slash). */
export function drivePathFor(destPath, relPath) {
  const rel = relPath.split(/[\\/]+/).filter(Boolean).join("/");
  return rel ? `${destPath.replace(/\/$/, "")}/${rel}` : destPath;
}

/** Parse one MCP tool result: the text content as JSON, or an error. */
export function parseToolResult(rpc) {
  if (rpc.error) throw new Error(`MCP error ${rpc.error.code}: ${rpc.error.message}`);
  const r = rpc.result ?? {};
  const text = (r.content ?? []).map((c) => c.text ?? "").join("");
  if (r.isError) throw new Error(text || "tool error");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Extract JSON-RPC messages from a Streamable HTTP response body (plain JSON or text/event-stream). */
export function parseRpcBody(contentType, body) {
  if (/text\/event-stream/i.test(contentType)) {
    const out = [];
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        out.push(JSON.parse(data));
      } catch {
        /* keep-alive or partial */
      }
    }
    return out;
  }
  if (!body.trim()) return [];
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
}
