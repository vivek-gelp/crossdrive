/**
 * Uploads that do not fit a 4.5 MB Vercel request body: Drive resumable
 * upload sessions. `beginUploadSession` is what `upload_begin` hands to the
 * client (the session URL is pre-authorised; the client PUTs the bytes
 * straight to Google). `putToSession` streams an async byte source into a
 * session in 256 KiB-aligned chunks with Content-Range headers (used for
 * `put sourceUrl` and for large mail attachments). `uploadBytes` picks
 * multipart for small payloads and a session for the rest.
 */
import type { DriveClient, DriveFile, FetchLike } from "./drive";

/** 8 MiB: a multiple of 256 KiB, as Google requires for every chunk but the last. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** Payloads up to this size go through one multipart request; above it a resumable session is used. */
export const MULTIPART_LIMIT = 5 * 1024 * 1024;
/** `put sourceUrl`: refuse sources larger than this. */
export const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
/** Google keeps a resumable session for about a week. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface UploadMeta {
  name: string;
  parents: string[];
  mimeType?: string;
}

export interface PutOpts {
  /** Total size when known (sent on every Content-Range); otherwise `*` until the final chunk. */
  size?: number;
  chunkBytes?: number;
  /** Abort (and leave the session dangling, which Google expires) once more than this many bytes have been read. */
  maxBytes?: number;
}

async function* chunked(source: AsyncIterable<Uint8Array>, chunkBytes: number, maxBytes: number | undefined): AsyncGenerator<{ chunk: Uint8Array<ArrayBuffer>; last: boolean }> {
  let buf: Uint8Array[] = [];
  let buffered = 0;
  let total = 0;
  const flush = (last: boolean) => {
    const out = buf.length === 1 ? buf[0]! : Buffer.concat(buf.map((b) => Buffer.from(b)));
    buf = [];
    buffered = 0;
    return { chunk: new Uint8Array(out), last };
  };
  for await (const piece of source) {
    if (piece.length === 0) continue;
    total += piece.length;
    if (maxBytes !== undefined && total > maxBytes) throw new Error(`Source exceeds ${maxBytes} bytes`);
    buf.push(piece);
    buffered += piece.length;
    while (buffered >= chunkBytes) {
      // Emit exactly chunkBytes, keep the remainder.
      const all = Buffer.concat(buf.map((b) => Buffer.from(b)));
      buf = [all.subarray(chunkBytes)];
      buffered = buf[0]!.length;
      yield { chunk: new Uint8Array(all.subarray(0, chunkBytes)), last: false };
    }
  }
  yield flush(true);
}

/** A Drive resumable-upload PUT: 308 means "more please", 200/201 carries the file. */
async function putChunk(fetchImpl: FetchLike, uploadUrl: string, chunk: Uint8Array<ArrayBuffer>, start: number, total: number | undefined): Promise<DriveFile | undefined> {
  const end = start + chunk.length - 1;
  const range = chunk.length === 0 ? `bytes */${total ?? 0}` : `bytes ${start}-${end}/${total ?? "*"}`;
  const res = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: { "Content-Range": range, "Content-Length": String(chunk.length) },
    body: chunk.length ? chunk : undefined,
    redirect: "manual",
  });
  if (res.status === 308) return undefined;
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`Drive upload ${res.status}${detail ? `: ${detail}` : ""} (chunk ${range})`);
  }
  return (await res.json()) as DriveFile;
}

/**
 * Stream `source` into the session at `uploadUrl`. Every chunk but the last
 * is `chunkBytes` long (a multiple of 256 KiB); the last one carries the
 * total so Google can finish the file. Returns Drive's file resource.
 */
export async function putToSession(fetchImpl: FetchLike, uploadUrl: string, source: AsyncIterable<Uint8Array>, opts: PutOpts = {}): Promise<DriveFile> {
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  if (chunkBytes % (256 * 1024) !== 0) throw new Error("chunkBytes must be a multiple of 256 KiB");
  let offset = 0;
  for await (const { chunk, last } of chunked(source, chunkBytes, opts.maxBytes)) {
    const total = last ? offset + chunk.length : opts.size;
    const file = await putChunk(fetchImpl, uploadUrl, chunk, offset, total);
    offset += chunk.length;
    if (file) return file;
    if (last) throw new Error("Drive did not finish the upload after the final chunk");
  }
  throw new Error("Empty upload source");
}

/** Wrap a web ReadableStream (e.g. `Response.body`) as an async iterable of bytes. */
export async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Multipart for small payloads, a resumable session otherwise (the whole payload is in memory either way). */
export async function uploadBytes(drive: DriveClient, fetchImpl: FetchLike, meta: UploadMeta, bytes: Uint8Array, contentType: string): Promise<DriveFile> {
  if (bytes.length <= MULTIPART_LIMIT) return drive.upload(meta, bytes, contentType);
  const uploadUrl = await drive.beginResumableUpload(meta, contentType, bytes.length);
  return putToSession(
    fetchImpl,
    uploadUrl,
    (async function* () {
      yield bytes;
    })(),
    { size: bytes.length },
  );
}

export interface UrlUploadArgs {
  sourceUrl: string;
  name: string;
  folderId: string;
  mimeType?: string;
}

export interface UrlUploadResult {
  file: DriveFile;
  bytes: number;
  contentType: string;
}

/** Fetch an https URL and stream it into a new Drive file without buffering more than one chunk. */
export async function uploadFromUrl(drive: DriveClient, fetchImpl: FetchLike, a: UrlUploadArgs, opts: { maxBytes?: number; chunkBytes?: number } = {}): Promise<UrlUploadResult> {
  let url: URL;
  try {
    url = new URL(a.sourceUrl);
  } catch {
    throw new Error(`sourceUrl is not a valid URL: ${a.sourceUrl}`);
  }
  if (url.protocol !== "https:") throw new Error("sourceUrl must use https");
  const maxBytes = opts.maxBytes ?? MAX_SOURCE_BYTES;
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`sourceUrl answered ${res.status}`);
  if (!res.body) throw new Error("sourceUrl returned no body");
  const lengthHeader = res.headers.get("content-length");
  const size = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : undefined;
  if (size !== undefined && size > maxBytes) throw new Error(`sourceUrl is ${size} bytes; the limit is ${maxBytes} bytes (${Math.round(maxBytes / 1024 / 1024)} MB)`);
  const contentType = a.mimeType ?? (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
  const uploadUrl = await drive.beginResumableUpload({ name: a.name, parents: [a.folderId], mimeType: a.mimeType }, contentType, size);
  let bytes = 0;
  const counted = (async function* () {
    for await (const c of streamChunks(res.body!)) {
      bytes += c.length;
      yield c;
    }
  })();
  const file = await putToSession(fetchImpl, uploadUrl, counted, { size, chunkBytes: opts.chunkBytes, maxBytes });
  return { file, bytes, contentType };
}
