/**
 * Minimal Google Drive v3 REST client over fetch. One instance per account
 * request; the access token is supplied by the caller (see google.ts).
 *
 * Every files.* call sends `supportsAllDrives=true`; listing/searching calls
 * also send `includeItemsFromAllDrives=true` and `corpora=allDrives`, so
 * Shared Drive content is visible everywhere. There is deliberately no
 * `files.delete`: trash is the only delete. Requests are retried on rate
 * limits and (idempotent calls) 5xx, see retry.ts.
 */
import { fetchWithRetry, isIdempotentMethod } from "./retry";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
export const FILE_FIELDS =
  "id,name,mimeType,modifiedTime,size,md5Checksum,webViewLink,parents,trashed,owners(emailAddress),capabilities(canEdit,canAddChildren,canShare),shared,driveId,shortcutDetails(targetId,targetMimeType)";
export const PERMISSION_FIELDS = "id,type,role,emailAddress,displayName,pendingOwner";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  webViewLink?: string;
  parents?: string[];
  trashed?: boolean;
  /** Absent for Shared Drive items; owners[0] is the owner for My Drive / shared-with-me items. */
  owners?: { emailAddress?: string }[];
  capabilities?: { canEdit?: boolean; canAddChildren?: boolean; canShare?: boolean };
  /** True when the file has been shared with anyone (set by Drive, not by us). */
  shared?: boolean;
  /** Set for items that live in a Shared Drive; the drive's root folder has `id === driveId`. */
  driveId?: string;
  /** Present on shortcuts (`application/vnd.google-apps.shortcut`). */
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

export interface DriveList {
  files: DriveFile[];
  nextPageToken?: string;
}

export interface SharedDrive {
  id: string;
  name: string;
}

export interface Permission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
  displayName?: string;
  pendingOwner?: boolean;
}

export interface SearchOpts {
  query: string;
  folderId?: string;
  mimeType?: string;
  /** Shortcut for mimeType = folder. */
  foldersOnly?: boolean;
  /** Default true: Drive's default corpus already includes items shared with the account. False adds `'me' in owners`. */
  includeShared?: boolean;
  modifiedAfter?: string;
  limit?: number;
}

export interface SharedListOpts {
  /** Case-insensitive `name contains`. */
  query?: string;
  foldersOnly?: boolean;
  pageToken?: string;
  limit?: number;
}

export interface ListFilesOpts {
  q: string;
  orderBy?: string;
  /** 1..1000 (Drive's maximum). */
  pageSize?: number;
  pageToken?: string;
  /** Per-file field list; defaults to FILE_FIELDS. */
  fields?: string;
}

export type FetchLike = typeof fetch;

export class DriveError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** The account cannot list Shared Drives (Drive answered 403/404 on drives.list). */
export class SharedDrivesUnavailableError extends DriveError {}

export function escapeQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Query params that make Shared Drive content visible on list/search calls. */
const ALL_DRIVES_LIST = { supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives" } as const;

export class DriveClient {
  private readonly base: string;

  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
    base = "https://www.googleapis.com",
  ) {
    this.base = base.replace(/\/$/, "");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    const res = await fetchWithRetry(this.fetchImpl, `${this.base}${path}`, { ...init, headers }, { idempotent: isIdempotentMethod(init.method) });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body.error?.message ?? "";
      } catch {
        /* ignore */
      }
      throw new DriveError(`Drive API ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.request(path, init)).json() as Promise<T>;
  }

  private postJson<T>(path: string, body: unknown, method = "POST"): Promise<T> {
    return this.json<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  async about(): Promise<{ user?: { emailAddress?: string }; storageQuota?: { limit?: string; usage?: string } }> {
    return this.json("/drive/v3/about?fields=user(emailAddress),storageQuota(limit,usage)");
  }

  async rootId(): Promise<string> {
    const r = await this.json<{ id: string }>("/drive/v3/files/root?fields=id");
    return r.id;
  }

  async getFile(id: string): Promise<DriveFile> {
    const q = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true" });
    return this.json(`/drive/v3/files/${encodeURIComponent(id)}?${q}`);
  }

  /** One page of `files.list` for an arbitrary query, with Shared Drive items included. */
  async listFiles(opts: ListFilesOpts): Promise<DriveList> {
    const q = new URLSearchParams({
      q: opts.q,
      fields: `nextPageToken,incompleteSearch,files(${opts.fields ?? FILE_FIELDS})`,
      pageSize: String(Math.min(Math.max(opts.pageSize ?? 100, 1), 1000)),
      ...ALL_DRIVES_LIST,
    });
    if (opts.orderBy) q.set("orderBy", opts.orderBy);
    if (opts.pageToken) q.set("pageToken", opts.pageToken);
    return this.json(`/drive/v3/files?${q}`);
  }

  async listChildren(parentId: string, pageToken?: string): Promise<DriveList> {
    return this.listFiles({
      q: `'${escapeQ(parentId)}' in parents and trashed = false`,
      orderBy: "folder,name",
      pageSize: 100,
      pageToken,
    });
  }

  async search(opts: SearchOpts): Promise<DriveFile[]> {
    return (await this.searchPage(opts)).files;
  }

  /** One page of a search; `pageToken` continues a previous page of the same query and page size. */
  async searchPage(opts: SearchOpts & { pageToken?: string }): Promise<DriveList> {
    const term = escapeQ(opts.query);
    const parts = [`(name contains '${term}' or fullText contains '${term}')`, "trashed = false"];
    if (opts.folderId) parts.push(`'${escapeQ(opts.folderId)}' in parents`);
    const mime = opts.foldersOnly ? FOLDER_MIME : opts.mimeType;
    if (mime) parts.push(`mimeType = '${escapeQ(mime)}'`);
    if (opts.includeShared === false) parts.push("'me' in owners");
    if (opts.modifiedAfter) parts.push(`modifiedTime > '${escapeQ(opts.modifiedAfter)}'`);
    // fullText queries cannot be combined with orderBy on Drive; sort client-side.
    return this.listFiles({ q: parts.join(" and "), pageSize: Math.min(Math.max(opts.limit ?? 20, 1), 100), pageToken: opts.pageToken });
  }

  /** Items shared directly with this account ("Shared with me"), most recently shared first. */
  async listSharedWithMe(opts: SharedListOpts): Promise<DriveList> {
    const parts = ["sharedWithMe = true", "trashed = false"];
    if (opts.foldersOnly) parts.push(`mimeType = '${FOLDER_MIME}'`);
    if (opts.query) parts.push(`name contains '${escapeQ(opts.query)}'`);
    return this.listFiles({
      q: parts.join(" and "),
      orderBy: "sharedWithMeTime desc",
      pageSize: Math.min(Math.max(opts.limit ?? 50, 1), 100),
      pageToken: opts.pageToken,
    });
  }

  /**
   * The top-level folder of a `label:~shared/<name>/...` path: a folder shared
   * with this account whose name equals `name` (case-insensitive; Drive's
   * `name contains` is case-insensitive, the exact match is done here).
   */
  async findSharedFolderByName(name: string): Promise<DriveFile | undefined> {
    const target = name.toLowerCase();
    let pageToken: string | undefined;
    do {
      const page = await this.listSharedWithMe({ query: name, foldersOnly: true, pageToken, limit: 100 });
      const hit = page.files.find((f) => f.name.toLowerCase() === target);
      if (hit) return hit;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return undefined;
  }

  async findChildByName(parentId: string, name: string, onlyFolders: boolean): Promise<DriveFile | undefined> {
    const parts = [`'${escapeQ(parentId)}' in parents`, `name = '${escapeQ(name)}'`, "trashed = false"];
    if (onlyFolders) parts.push(`mimeType = '${FOLDER_MIME}'`);
    const r = await this.listFiles({ q: parts.join(" and "), pageSize: 1 });
    return r.files[0];
  }

  // ---- Shared Drives -------------------------------------------------------

  /**
   * All Shared Drives the account is a member of (empty when it is a member of
   * none). When Drive refuses drives.list (403/404: consumer accounts, or a
   * Workspace account without access) this throws SharedDrivesUnavailableError
   * instead of pretending the list is empty; callers decide what that means.
   */
  async listDrives(): Promise<SharedDrive[]> {
    const out: SharedDrive[] = [];
    let pageToken: string | undefined;
    try {
      do {
        const q = new URLSearchParams({ pageSize: "100", fields: "nextPageToken,drives(id,name)" });
        if (pageToken) q.set("pageToken", pageToken);
        const page = await this.json<{ drives?: SharedDrive[]; nextPageToken?: string }>(`/drive/v3/drives?${q}`);
        out.push(...(page.drives ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (e) {
      if (e instanceof DriveError && (e.status === 403 || e.status === 404)) {
        throw new SharedDrivesUnavailableError(`Shared Drives are not reachable for this account (${e.message})`, e.status);
      }
      throw e;
    }
    return out;
  }

  async findDriveByName(name: string): Promise<SharedDrive | undefined> {
    const target = name.toLowerCase();
    let drives: SharedDrive[];
    try {
      drives = await this.listDrives();
    } catch (e) {
      if (e instanceof SharedDrivesUnavailableError) throw new SharedDrivesUnavailableError(`Shared Drive "${name}" is not reachable: ${e.message}`, e.status);
      throw e;
    }
    return drives.find((d) => d.name.toLowerCase() === target);
  }

  // ---- writes --------------------------------------------------------------

  private createFile(meta: Record<string, unknown>): Promise<DriveFile> {
    const q = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true" });
    return this.postJson(`/drive/v3/files?${q}`, meta);
  }

  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    return this.createFile({ name, mimeType: FOLDER_MIME, parents: [parentId] });
  }

  /** A Drive shortcut (`application/vnd.google-apps.shortcut`) in `parentId` pointing at `targetId`. */
  async createShortcut(name: string, targetId: string, parentId: string): Promise<DriveFile> {
    return this.createFile({ name, mimeType: SHORTCUT_MIME, parents: [parentId], shortcutDetails: { targetId } });
  }

  /** `files.copy`: Drive copies server-side, Google-native types keep their type. */
  async copy(id: string, meta: { name?: string; parents: string[] }): Promise<DriveFile> {
    const q = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true" });
    return this.postJson(`/drive/v3/files/${encodeURIComponent(id)}/copy?${q}`, meta);
  }

  async upload(meta: { name: string; parents: string[]; mimeType?: string }, content: Uint8Array, contentType: string): Promise<DriveFile> {
    const boundary = `crossdrive${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + content.length + tail.length);
    body.set(head, 0);
    body.set(content, head.length);
    body.set(tail, head.length + content.length);
    return this.json(`/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  /**
   * Open a resumable upload session (`uploadType=resumable`) and return its
   * URL. The URL is the credential: whoever holds it can PUT the bytes with
   * `Content-Range` headers and no Authorization header; Google keeps the
   * session for about a week. The `fields` of the final response are fixed here.
   */
  async beginResumableUpload(meta: { name: string; parents: string[]; mimeType?: string }, contentType: string, size?: number): Promise<string> {
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": contentType };
    if (size !== undefined) headers["X-Upload-Content-Length"] = String(size);
    const res = await this.request(`/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
      method: "POST",
      headers,
      body: JSON.stringify(meta),
    });
    const location = res.headers.get("location");
    if (!location) throw new DriveError("Drive did not return an upload session URL", res.status);
    return location;
  }

  async patch(id: string, body: Record<string, unknown>, query?: Record<string, string>): Promise<DriveFile> {
    const q = new URLSearchParams({ fields: FILE_FIELDS, supportsAllDrives: "true", ...(query ?? {}) });
    return this.postJson(`/drive/v3/files/${encodeURIComponent(id)}?${q}`, body, "PATCH");
  }

  rename(id: string, name: string) {
    return this.patch(id, { name });
  }

  move(id: string, toFolderId: string, fromFolderIds: string[]) {
    return this.patch(id, {}, { addParents: toFolderId, removeParents: fromFolderIds.join(",") });
  }

  setTrashed(id: string, trashed: boolean) {
    return this.patch(id, { trashed });
  }

  // ---- permissions ---------------------------------------------------------

  async listPermissions(fileId: string): Promise<Permission[]> {
    const out: Permission[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ fields: `nextPageToken,permissions(${PERMISSION_FIELDS})`, pageSize: "100", supportsAllDrives: "true" });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await this.json<{ permissions?: Permission[]; nextPageToken?: string }>(
        `/drive/v3/files/${encodeURIComponent(fileId)}/permissions?${q}`,
      );
      out.push(...(page.permissions ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async createPermission(
    fileId: string,
    body: { type: "user" | "group" | "domain" | "anyone"; role: string; emailAddress?: string },
    opts: { sendNotificationEmail: boolean; emailMessage?: string; transferOwnership?: boolean },
  ): Promise<Permission> {
    const q = new URLSearchParams({
      fields: PERMISSION_FIELDS,
      supportsAllDrives: "true",
      sendNotificationEmail: String(opts.sendNotificationEmail),
    });
    if (opts.emailMessage) q.set("emailMessage", opts.emailMessage);
    if (opts.transferOwnership) q.set("transferOwnership", "true");
    return this.postJson(`/drive/v3/files/${encodeURIComponent(fileId)}/permissions?${q}`, body);
  }

  async updatePermission(fileId: string, permissionId: string, body: { role: string; pendingOwner?: boolean }): Promise<Permission> {
    const q = new URLSearchParams({ fields: PERMISSION_FIELDS, supportsAllDrives: "true" });
    return this.postJson(`/drive/v3/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?${q}`, body, "PATCH");
  }

  /** Removes one sharing permission from a file. The file itself is never deleted. */
  async removePermission(fileId: string, permissionId: string): Promise<void> {
    const q = new URLSearchParams({ supportsAllDrives: "true" });
    await this.request(`/drive/v3/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}?${q}`, { method: "DELETE" });
  }

  /** Download raw bytes, or export a Google-native file to `exportMime`. */
  async download(id: string, exportMime?: string): Promise<{ bytes: Buffer; contentType: string }> {
    const path = exportMime
      ? `/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=${encodeURIComponent(exportMime)}`
      : `/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`;
    const res = await this.request(path);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: exportMime ?? res.headers.get("content-type") ?? "application/octet-stream",
    };
  }
}
