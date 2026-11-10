/**
 * OneDrive (personal and work/school) over Microsoft Graph v1.0, addressed
 * through `/me/drive`. Documented behaviour this adapter relies on:
 *
 * - items by id `/me/drive/items/{id}`, by path `/me/drive/root:/a/b`, a
 *   child by name `/me/drive/items/{parent}:/{name}`;
 * - children pages carry `@odata.nextLink` (an absolute Graph URL; it is the
 *   page token and is checked to point at Graph before it is followed);
 * - new folders and files use `@microsoft.graph.conflictBehavior: fail`, so
 *   nothing is ever overwritten (409 nameAlreadyExists instead);
 * - uploads use createUploadSession; every fragment but the last is a
 *   multiple of 320 KiB, PUT to the pre-authenticated uploadUrl WITHOUT an
 *   Authorization header; 202 means "more", 200/201 carries the driveItem;
 *   416 means the fragment was already received. Zero-byte files go through
 *   the simple `:/content` upload since a session needs at least one byte;
 * - `/content` answers 302 to a pre-authenticated download URL that honours
 *   Range; the URL is fetched without our bearer token;
 * - DELETE moves an item to the recycle bin (permanentDelete is never used);
 * - throttling is 429/503 with Retry-After (see http.ts).
 */
import { fetchWithRetry, iterateStream } from "./http";
import { joinPath, ProviderError, type Capabilities, type Download, type Entry, type Hashes, type Page, type StorageProvider, type UploadHandle } from "./types";

export const GRAPH = "https://graph.microsoft.com/v1.0";
/** 25 × 320 KiB = 8,192,000 bytes: a valid Graph fragment size just under 8 MiB. */
export const ONEDRIVE_CHUNK = 25 * 320 * 1024;

export const ONEDRIVE_CAPS: Capabilities = {
  hashes: ["quickXor", "sha1", "sha256"],
  chunkBytes: ONEDRIVE_CHUNK,
  maxFileBytes: 250 * 1024 ** 3,
  maxPathChars: 400,
  maxNameChars: 255,
  uniqueNames: true,
  rangeDownload: true,
};

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  folder?: { childCount?: number };
  file?: { mimeType?: string; hashes?: { quickXorHash?: string; sha1Hash?: string; sha256Hash?: string } };
  root?: object;
  parentReference?: { id?: string; path?: string };
}

const SELECT = "id,name,size,lastModifiedDateTime,folder,file,root,parentReference";

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/** `/drive/root:/A/B` → `/A/B`. */
function parentPathOf(item: DriveItem): string | undefined {
  const p = item.parentReference?.path;
  if (!p) return undefined;
  const i = p.indexOf("root:");
  if (i < 0) return undefined;
  const rest = decodeURIComponent(p.slice(i + 5));
  return rest === "" ? "/" : rest;
}

export function toEntry(item: DriveItem, parentPath?: string): Entry {
  const hashes: Hashes = {};
  const h = item.file?.hashes;
  if (h?.quickXorHash) hashes.quickXor = h.quickXorHash;
  if (h?.sha1Hash) hashes.sha1 = h.sha1Hash.toLowerCase();
  if (h?.sha256Hash) hashes.sha256 = h.sha256Hash.toLowerCase();
  const pp = parentPath ?? parentPathOf(item);
  return {
    id: item.id,
    name: item.root ? "" : item.name,
    path: item.root ? "/" : pp ? joinPath(pp, item.name) : `/${item.name}`,
    isFolder: !!item.folder || !!item.root,
    size: item.folder || item.root ? undefined : item.size,
    modified: item.lastModifiedDateTime,
    hash: Object.keys(hashes).length ? hashes : undefined,
    mimeType: item.file?.mimeType,
  };
}

async function graphError(res: Response, what: string): Promise<ProviderError> {
  let code: string | undefined;
  let message = "";
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    code = j.error?.code;
    message = j.error?.message ?? "";
  } catch {
    /* ignore */
  }
  return new ProviderError(`OneDrive ${what} ${res.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`, res.status, code);
}

export class OneDriveProvider implements StorageProvider {
  readonly kind = "microsoft" as const;
  readonly caps = ONEDRIVE_CAPS;

  constructor(
    readonly label: string,
    private readonly token: () => Promise<string>,
  ) {}

  private async api<T>(method: string, pathOrUrl: string, body?: unknown, what = method): Promise<T> {
    const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetchWithRetry(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) throw await graphError(res, what);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async root(): Promise<Entry> {
    return toEntry(await this.api<DriveItem>("GET", `/me/drive/root?$select=${SELECT}`, undefined, "root"));
  }

  async stat(path: string): Promise<Entry> {
    const p = encodePath(path);
    if (!p) return this.root();
    const item = await this.api<DriveItem>("GET", `/me/drive/root:/${p}?$select=${SELECT}`, undefined, `stat ${path}`);
    return toEntry(item);
  }

  async statId(id: string): Promise<Entry> {
    return toEntry(await this.api<DriveItem>("GET", `/me/drive/items/${encodeURIComponent(id)}?$select=${SELECT}`, undefined, "get item"));
  }

  async child(folder: Entry, name: string): Promise<Entry | undefined> {
    try {
      const item = await this.api<DriveItem>("GET", `/me/drive/items/${encodeURIComponent(folder.id)}:/${encodeURIComponent(name)}?$select=${SELECT}`, undefined, "lookup");
      return toEntry(item, folder.path);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return undefined;
      throw e;
    }
  }

  async list(folder: Entry, pageToken?: string): Promise<Page> {
    let url = `/me/drive/items/${encodeURIComponent(folder.id)}/children?$top=200&$select=${SELECT}`;
    if (pageToken) {
      if (!pageToken.startsWith(`${GRAPH}/`)) throw new Error("Invalid OneDrive page token");
      url = pageToken;
    }
    const r = await this.api<{ value: DriveItem[]; "@odata.nextLink"?: string }>("GET", url, undefined, "list");
    return { entries: r.value.map((i) => toEntry(i, folder.path)), nextPageToken: r["@odata.nextLink"] };
  }

  async find(query: string, limit: number, under?: Entry): Promise<Entry[]> {
    const q = encodeURIComponent(query.replace(/'/g, "''"));
    const base = under ? `/me/drive/items/${encodeURIComponent(under.id)}` : "/me/drive/root";
    const r = await this.api<{ value: DriveItem[] }>("GET", `${base}/search(q='${q}')?$top=${Math.min(Math.max(limit, 1), 200)}&$select=${SELECT}`, undefined, "search");
    return r.value.slice(0, limit).map((i) => toEntry(i));
  }

  async mkdir(parent: Entry, name: string): Promise<Entry> {
    try {
      const item = await this.api<DriveItem>(
        "POST",
        `/me/drive/items/${encodeURIComponent(parent.id)}/children`,
        { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" },
        "mkdir",
      );
      return toEntry(item, parent.path);
    } catch (e) {
      if (!(e instanceof ProviderError && e.status === 409)) throw e;
      const existing = await this.child(parent, name);
      if (existing?.isFolder) return existing;
      throw new ProviderError(`A file named "${name}" already exists in ${parent.path}`, 409, "nameAlreadyExists");
    }
  }

  async download(entry: Entry, offset = 0): Promise<Download> {
    const first = await fetchWithRetry(`${GRAPH}/me/drive/items/${encodeURIComponent(entry.id)}/content`, {
      headers: { Authorization: `Bearer ${await this.token()}`, ...(offset ? { Range: `bytes=${offset}-` } : {}) },
      redirect: "manual",
    });
    let res = first;
    if (first.status >= 300 && first.status < 400) {
      const location = first.headers.get("location");
      if (!location) throw new ProviderError("OneDrive download redirect without a Location", first.status);
      res = await fetchWithRetry(location, { headers: offset ? { Range: `bytes=${offset}-` } : {} });
    }
    if (!res.ok) throw await graphError(res, "download");
    if (offset > 0 && res.status !== 206) throw new ProviderError("OneDrive ignored the Range request; cannot resume this file mid-way", res.status);
    return {
      stream: iterateStream(res.body),
      size: entry.size === undefined ? undefined : entry.size - offset,
      contentType: res.headers.get("content-type") ?? entry.mimeType ?? "application/octet-stream",
      name: entry.name,
    };
  }

  async beginUpload(parent: Entry, name: string, size: number): Promise<UploadHandle> {
    if (size === 0) return { provider: "microsoft", session: "", parentId: parent.id, parentPath: parent.path, size, name };
    const r = await this.api<{ uploadUrl: string }>(
      "POST",
      `/me/drive/items/${encodeURIComponent(parent.id)}:/${encodeURIComponent(name)}:/createUploadSession`,
      { item: { "@microsoft.graph.conflictBehavior": "fail", name } },
      "createUploadSession",
    );
    return { provider: "microsoft", session: r.uploadUrl, parentId: parent.id, parentPath: parent.path, size, name };
  }

  async putChunk(h: UploadHandle, offset: number, chunk: Uint8Array, last: boolean): Promise<Entry | undefined> {
    if (h.size === 0) {
      const item = await this.api<DriveItem>(
        "PUT",
        `/me/drive/items/${encodeURIComponent(h.parentId ?? "")}:/${encodeURIComponent(h.name)}:/content?@microsoft.graph.conflictBehavior=fail`,
        undefined,
        "upload",
      );
      return toEntry(item, h.parentPath);
    }
    if (!last && chunk.length % (320 * 1024) !== 0) throw new Error("OneDrive fragments must be multiples of 320 KiB");
    const end = offset + chunk.length - 1;
    const res = await fetchWithRetry(h.session, {
      method: "PUT",
      headers: { "Content-Length": String(chunk.length), "Content-Range": `bytes ${offset}-${end}/${h.size}` },
      body: chunk as Uint8Array<ArrayBuffer>,
    });
    if (res.status === 202) {
      await res.arrayBuffer().catch(() => undefined);
      return undefined;
    }
    if (res.status === 200 || res.status === 201) return toEntry((await res.json()) as DriveItem, h.parentPath);
    if (res.status === 416) {
      // Already received (e.g. a retried request whose first attempt landed). Confirm with the session status.
      const st = await fetchWithRetry(h.session, { method: "GET" });
      if (st.ok) {
        const j = (await st.json()) as { nextExpectedRanges?: string[] };
        const next = Number((j.nextExpectedRanges?.[0] ?? "").split("-")[0]);
        if (Number.isFinite(next) && next > end) return undefined;
      }
    }
    throw await graphError(res, `upload fragment bytes ${offset}-${end}`);
  }

  async finishUpload(h: UploadHandle, done: Entry | undefined): Promise<Entry> {
    if (!done) throw new ProviderError(`OneDrive did not complete the upload of ${h.name} after the last fragment`, 500);
    return done;
  }

  async move(entry: Entry, toFolder: Entry): Promise<Entry> {
    const item = await this.api<DriveItem>("PATCH", `/me/drive/items/${encodeURIComponent(entry.id)}`, { parentReference: { id: toFolder.id } }, "move");
    return toEntry(item, toFolder.path);
  }

  async rename(entry: Entry, newName: string): Promise<Entry> {
    const item = await this.api<DriveItem>("PATCH", `/me/drive/items/${encodeURIComponent(entry.id)}`, { name: newName }, "rename");
    return toEntry(item);
  }

  async trash(entry: Entry): Promise<void> {
    if (entry.path === "/") throw new Error("Refusing to trash the drive root");
    await this.api<void>("DELETE", `/me/drive/items/${encodeURIComponent(entry.id)}`, undefined, "delete (to recycle bin)");
  }
}
