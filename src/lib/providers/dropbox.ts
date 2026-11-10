/**
 * Dropbox over API v2. RPC routes are JSON POSTs to api.dropboxapi.com;
 * content routes (download, upload sessions) send their argument in the
 * `Dropbox-API-Arg` header, which must be ASCII, so non-ASCII characters are
 * escaped as \uXXXX. Addressing is by path (`/A/b.txt`, the root is the empty
 * string); stable ids (`id:...`) are accepted where the API takes a
 * PathOrId (metadata, list, download, move source, delete).
 *
 * - Endpoint errors are 409 with `error_summary` (`path/not_found/..`,
 *   `path/conflict/..`, `to/conflict/..`); they are mapped to 404 / 409.
 * - Uploads: upload_session/start (no data) → append_v2 per chunk →
 *   finish with commit `{mode: add, autorename: false, strict_conflict: true}`
 *   so an existing file is never overwritten. ≤150 MB per request, sessions
 *   live 48 h, files up to 350 GB.
 * - delete_v2 moves the item to Dropbox's deleted files (restorable); the
 *   permanently_delete route is never used.
 * - Throttling: 429 with Retry-After (too_many_requests / too_many_write_operations).
 */
import { fetchWithRetry, iterateStream } from "./http";
import { joinPath, ProviderError, type Capabilities, type Download, type Entry, type Page, type StorageProvider, type UploadHandle } from "./types";

export const DROPBOX_API = "https://api.dropboxapi.com/2";
export const DROPBOX_CONTENT = "https://content.dropboxapi.com/2";
export const DROPBOX_CHUNK = 8 * 1024 * 1024;

export const DROPBOX_CAPS: Capabilities = {
  hashes: ["dropbox"],
  chunkBytes: DROPBOX_CHUNK,
  maxFileBytes: 350 * 1000 ** 3,
  // help.dropbox.com: "File paths must be fewer than 260 characters."
  maxPathChars: 259,
  maxNameChars: 255,
  uniqueNames: true,
  rangeDownload: true,
};

interface DbxMetadata {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  id?: string;
  path_lower?: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
}

/** JSON for the Dropbox-API-Arg header: HTTP headers must be ASCII. */
export function headerArg(arg: unknown): string {
  return JSON.stringify(arg).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function toEntry(m: DbxMetadata): Entry {
  const path = m.path_display ?? m.path_lower ?? `/${m.name}`;
  return {
    id: m.id ?? path,
    name: m.name,
    path,
    isFolder: m[".tag"] === "folder",
    size: m[".tag"] === "file" ? m.size : undefined,
    modified: m.server_modified,
    hash: m.content_hash ? { dropbox: m.content_hash.toLowerCase() } : undefined,
  };
}

const ROOT: Entry = { id: "", name: "", path: "/", isFolder: true };

/** What to send as `path` for an entry: the root is "", otherwise the stable id. */
function apiRef(e: Entry): string {
  if (e.path === "/" || e.id === "") return "";
  return e.id.startsWith("id:") ? e.id : e.path;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

async function dbxError(res: Response, what: string): Promise<ProviderError> {
  let summary = "";
  try {
    const text = await res.text();
    try {
      summary = (JSON.parse(text) as { error_summary?: string }).error_summary ?? text;
    } catch {
      summary = text;
    }
  } catch {
    /* ignore */
  }
  summary = summary.slice(0, 300);
  let status = res.status;
  if (res.status === 409) {
    if (/not_found/.test(summary)) status = 404;
    else if (/conflict/.test(summary)) status = 409;
    else status = 400;
  }
  return new ProviderError(`Dropbox ${what} ${res.status}${summary ? `: ${summary}` : ""}`, status, summary || undefined);
}

export class DropboxProvider implements StorageProvider {
  readonly kind = "dropbox" as const;
  readonly caps = DROPBOX_CAPS;

  constructor(
    readonly label: string,
    private readonly token: () => Promise<string>,
  ) {}

  private async rpc<T>(route: string, arg: unknown, what = route): Promise<T> {
    const res = await fetchWithRetry(`${DROPBOX_API}/${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify(arg),
    });
    if (!res.ok) throw await dbxError(res, what);
    return (await res.json()) as T;
  }

  private async content(route: string, arg: unknown, body?: Uint8Array, extra: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}`, "Dropbox-API-Arg": headerArg(arg), ...extra };
    if (body !== undefined) headers["Content-Type"] = "application/octet-stream";
    const res = await fetchWithRetry(`${DROPBOX_CONTENT}/${route}`, { method: "POST", headers, body: body as Uint8Array<ArrayBuffer> | undefined });
    if (!res.ok) throw await dbxError(res, route);
    return res;
  }

  async root(): Promise<Entry> {
    return ROOT;
  }

  async stat(path: string): Promise<Entry> {
    const p = "/" + path.split("/").filter(Boolean).join("/");
    if (p === "/") return ROOT;
    return toEntry(await this.rpc<DbxMetadata>("files/get_metadata", { path: p }, `stat ${p}`));
  }

  async statId(id: string): Promise<Entry> {
    if (id === "" || id === "/") return ROOT;
    return toEntry(await this.rpc<DbxMetadata>("files/get_metadata", { path: id }, "get_metadata"));
  }

  async child(folder: Entry, name: string): Promise<Entry | undefined> {
    try {
      return toEntry(await this.rpc<DbxMetadata>("files/get_metadata", { path: joinPath(folder.path, name) }, "lookup"));
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return undefined;
      throw e;
    }
  }

  async list(folder: Entry, pageToken?: string): Promise<Page> {
    const r = pageToken
      ? await this.rpc<{ entries: DbxMetadata[]; cursor: string; has_more: boolean }>("files/list_folder/continue", { cursor: pageToken }, "list")
      : await this.rpc<{ entries: DbxMetadata[]; cursor: string; has_more: boolean }>("files/list_folder", { path: apiRef(folder), limit: 500 }, "list");
    return { entries: r.entries.filter((m) => m[".tag"] !== "deleted").map(toEntry), nextPageToken: r.has_more ? r.cursor : undefined };
  }

  async find(query: string, limit: number, under?: Entry): Promise<Entry[]> {
    const options: Record<string, unknown> = { max_results: Math.min(Math.max(limit, 1), 1000) };
    if (under && apiRef(under)) options.path = apiRef(under);
    const r = await this.rpc<{ matches: { metadata: { metadata: DbxMetadata } }[] }>("files/search_v2", { query, options }, "search");
    return r.matches.map((m) => toEntry(m.metadata.metadata)).slice(0, limit);
  }

  async mkdir(parent: Entry, name: string): Promise<Entry> {
    try {
      const r = await this.rpc<{ metadata: DbxMetadata }>("files/create_folder_v2", { path: joinPath(parent.path, name), autorename: false }, "mkdir");
      return toEntry({ ...r.metadata, ".tag": "folder" });
    } catch (e) {
      if (!(e instanceof ProviderError && e.status === 409)) throw e;
      const existing = await this.child(parent, name);
      if (existing?.isFolder) return existing;
      throw new ProviderError(`A file named "${name}" already exists in ${parent.path}`, 409, "conflict");
    }
  }

  async download(entry: Entry, offset = 0): Promise<Download> {
    const res = await this.content("files/download", { path: apiRef(entry) }, undefined, offset ? { Range: `bytes=${offset}-` } : {});
    if (offset > 0 && res.status !== 206) throw new ProviderError("Dropbox ignored the Range request; cannot resume this file mid-way", res.status);
    return {
      stream: iterateStream(res.body),
      size: entry.size === undefined ? undefined : entry.size - offset,
      contentType: "application/octet-stream",
      name: entry.name,
    };
  }

  async beginUpload(parent: Entry, name: string, size: number): Promise<UploadHandle> {
    const res = await this.content("upload_session/start", { close: false }, new Uint8Array(0));
    const { session_id } = (await res.json()) as { session_id: string };
    return { provider: "dropbox", session: session_id, commitPath: joinPath(parent.path, name), parentId: parent.id, parentPath: parent.path, size, name };
  }

  async putChunk(h: UploadHandle, offset: number, chunk: Uint8Array): Promise<Entry | undefined> {
    if (chunk.length === 0) return undefined;
    try {
      await this.content("upload_session/append_v2", { cursor: { session_id: h.session, offset }, close: false }, chunk);
    } catch (e) {
      // A retried append whose first attempt landed reports incorrect_offset with the offset it expects next.
      const m = e instanceof ProviderError ? /incorrect_offset.*?(\d+)/.exec(e.message) : null;
      if (m && Number(m[1]) === offset + chunk.length) return undefined;
      throw e;
    }
    return undefined;
  }

  async finishUpload(h: UploadHandle): Promise<Entry> {
    const res = await this.content(
      "upload_session/finish",
      {
        cursor: { session_id: h.session, offset: h.size },
        commit: { path: h.commitPath, mode: "add", autorename: false, mute: true, strict_conflict: true },
      },
      new Uint8Array(0),
    );
    return toEntry({ ...((await res.json()) as DbxMetadata), ".tag": "file" });
  }

  async move(entry: Entry, toFolder: Entry): Promise<Entry> {
    const r = await this.rpc<{ metadata: DbxMetadata }>("files/move_v2", { from_path: apiRef(entry), to_path: joinPath(toFolder.path, entry.name), autorename: false }, "move");
    return toEntry({ ...r.metadata, ".tag": entry.isFolder ? "folder" : "file" });
  }

  async rename(entry: Entry, newName: string): Promise<Entry> {
    const r = await this.rpc<{ metadata: DbxMetadata }>("files/move_v2", { from_path: apiRef(entry), to_path: joinPath(parentOf(entry.path), newName), autorename: false }, "rename");
    return toEntry({ ...r.metadata, ".tag": entry.isFolder ? "folder" : "file" });
  }

  async trash(entry: Entry): Promise<void> {
    if (apiRef(entry) === "") throw new Error("Refusing to delete the Dropbox root");
    await this.rpc("files/delete_v2", { path: apiRef(entry) }, "delete (to deleted files)");
  }
}
