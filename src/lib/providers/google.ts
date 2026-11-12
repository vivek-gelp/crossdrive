/**
 * Google Drive as a StorageProvider: a thin wrapper over the existing
 * DriveClient / ctx helpers. Paths accept the same three forms as the
 * Google-only tools (`/A/B`, `~shared/Top/B`, `drive/<Shared Drive>/B`).
 *
 * Bytes are streamed (alt=media with Range) rather than going through
 * DriveClient.download, which buffers. Google-native Docs/Sheets/Slides
 * (and Drawings) have no bytes and are exported to docx/xlsx/pptx (png) when
 * they leave Google; Drive caps exports at 10 MB, so an export is buffered.
 * Uploads use a resumable session in 8 MiB chunks (a multiple of 256 KiB).
 */
import { assertWritable, ctxFor, currentDriveFetch, folderFromPath, type Ctx } from "../ctx";
import { FOLDER_MIME, SHORTCUT_MIME, type DriveFile } from "../drive";
import { isGoogleNativeMime } from "../naming";
import { iterateStream } from "./http";
import { joinPath, ProviderError, type Capabilities, type Download, type Entry, type Page, type StorageProvider, type UploadHandle } from "./types";

const DRIVE_BASE = "https://www.googleapis.com";
export const GOOGLE_CHUNK = 8 * 1024 * 1024;

export const GOOGLE_CAPS: Capabilities = {
  hashes: ["md5"],
  chunkBytes: GOOGLE_CHUNK,
  maxFileBytes: 5 * 1024 ** 4,
  maxNameChars: 32_767,
  uniqueNames: false,
  rangeDownload: true,
};

/** Export format for each Google-native type that can leave Google. Others (Forms, Sites, Maps, ...) cannot be transferred. */
export const GOOGLE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" },
  "application/vnd.google-apps.spreadsheet": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" },
  "application/vnd.google-apps.presentation": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" },
  "application/vnd.google-apps.drawing": { mime: "image/png", ext: "png" },
};

/**
 * Native types an export can be imported back into (upload with the native mimeType as metadata: Drive converts
 * docx -> Doc, xlsx -> Sheet, pptx -> Slides). Drawings, Forms, Sites, Maps, ... have no import path.
 */
export const GOOGLE_IMPORTS = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
]);

/** The export to use when a native file must be re-created as the same native type in another Google account. */
export function importFor(e: Entry): { mime: string; ext: string } | undefined {
  return e.mimeType && GOOGLE_IMPORTS.has(e.mimeType) ? GOOGLE_EXPORTS[e.mimeType] : undefined;
}

export function exportFor(e: Entry): { mime: string; ext: string } | undefined {
  return e.mimeType ? GOOGLE_EXPORTS[e.mimeType] : undefined;
}

/** Name a Google-native file gets once exported (`Board notes` → `Board notes.docx`). */
export function exportedName(e: Entry): string {
  const x = exportFor(e);
  if (!x) return e.name;
  return e.name.toLowerCase().endsWith(`.${x.ext}`) ? e.name : `${e.name}.${x.ext}`;
}

export function toEntry(f: DriveFile, path: string): Entry {
  const isFolder = f.mimeType === FOLDER_MIME;
  const shortcut = f.mimeType === SHORTCUT_MIME;
  return {
    id: f.id,
    name: f.name,
    path,
    isFolder,
    size: f.size !== undefined ? Number(f.size) : undefined,
    modified: f.modifiedTime,
    hash: f.md5Checksum ? { md5: f.md5Checksum.toLowerCase() } : undefined,
    mimeType: f.mimeType,
    googleNative: !isFolder && !shortcut && isGoogleNativeMime(f.mimeType),
    shortcut: shortcut || undefined,
  };
}

function cleanPath(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length ? `/${segs.join("/")}` : "/";
}

export class GoogleProvider implements StorageProvider {
  readonly kind = "google" as const;
  readonly caps = GOOGLE_CAPS;
  private ctxPromise?: Promise<Ctx>;

  constructor(
    readonly label: string,
    private readonly token: () => Promise<string>,
  ) {}

  private ctx(): Promise<Ctx> {
    this.ctxPromise ??= ctxFor(this.label);
    return this.ctxPromise;
  }

  async root(): Promise<Entry> {
    const c = await this.ctx();
    return toEntry(await c.drive.getFile(c.rootId), "/");
  }

  async stat(path: string): Promise<Entry> {
    const c = await this.ctx();
    const p = cleanPath(path);
    if (p === "/") return this.root();
    try {
      const id = await folderFromPath(c, `${this.label}:${p}`);
      return toEntry(await c.drive.getFile(id), p);
    } catch (folderErr) {
      // Not a folder path: resolve the parent folder and look for a file of that name.
      const i = p.lastIndexOf("/");
      const parentPath = i <= 0 ? "/" : p.slice(0, i);
      const name = p.slice(i + 1);
      let parentId: string;
      try {
        parentId = await folderFromPath(c, `${this.label}:${parentPath}`);
      } catch {
        throw folderErr;
      }
      const f = await c.drive.findChildByName(parentId, name, false);
      if (!f) throw new ProviderError(`Not found: ${this.label}:${p}`, 404);
      return toEntry(f, p);
    }
  }

  async statId(id: string): Promise<Entry> {
    const c = await this.ctx();
    const f = await c.drive.getFile(id);
    return toEntry(f, id === c.rootId ? "/" : `/${f.name}`);
  }

  async child(folder: Entry, name: string): Promise<Entry | undefined> {
    const c = await this.ctx();
    const f = await c.drive.findChildByName(folder.id, name, false);
    return f ? toEntry(f, joinPath(folder.path, f.name)) : undefined;
  }

  async list(folder: Entry, pageToken?: string): Promise<Page> {
    const c = await this.ctx();
    const page = await c.drive.listChildren(folder.id, pageToken);
    return { entries: page.files.map((f) => toEntry(f, joinPath(folder.path, f.name))), nextPageToken: page.nextPageToken };
  }

  async find(query: string, limit: number, under?: Entry): Promise<Entry[]> {
    const c = await this.ctx();
    const files = await c.drive.search({ query, limit, folderId: under?.id });
    return files.map((f) => toEntry(f, under ? joinPath(under.path, f.name) : `/${f.name}`));
  }

  async mkdir(parent: Entry, name: string): Promise<Entry> {
    const c = await this.ctx();
    const existing = await c.drive.findChildByName(parent.id, name, true);
    if (existing) return toEntry(existing, joinPath(parent.path, name));
    assertWritable(await c.drive.getFile(parent.id), "addChildren");
    return toEntry(await c.drive.createFolder(name, parent.id), joinPath(parent.path, name));
  }

  async download(entry: Entry, offset = 0): Promise<Download> {
    const c = await this.ctx();
    if (entry.shortcut) throw new ProviderError(`${entry.name} is a Google Drive shortcut; shortcuts are not transferred`, 400);
    if (entry.googleNative) {
      const x = exportFor(entry);
      if (!x) throw new ProviderError(`${entry.name} (${entry.mimeType}) has no exportable format and cannot leave Google Drive`, 400);
      if (offset) throw new ProviderError("Exports cannot be resumed mid-way", 400);
      const { bytes } = await c.drive.download(entry.id, x.mime);
      return {
        stream: (async function* () {
          yield new Uint8Array(bytes);
        })(),
        size: bytes.length,
        contentType: x.mime,
        exportedAs: x.ext,
        name: exportedName(entry),
      };
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}` };
    if (offset) headers.Range = `bytes=${offset}-`;
    const res = await currentDriveFetch()(`${DRIVE_BASE}/drive/v3/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`, { headers });
    if (!res.ok) throw new ProviderError(`Drive download ${res.status}`, res.status);
    if (offset > 0 && res.status !== 206) throw new ProviderError("Drive ignored the Range request; cannot resume this file mid-way", res.status);
    return {
      stream: iterateStream(res.body),
      size: entry.size === undefined ? undefined : entry.size - offset,
      contentType: res.headers.get("content-type") ?? entry.mimeType ?? "application/octet-stream",
      name: entry.name,
    };
  }

  async beginUpload(parent: Entry, name: string, size: number, contentType: string, opts?: { convertTo?: string }): Promise<UploadHandle> {
    const c = await this.ctx();
    assertWritable(await c.drive.getFile(parent.id), "addChildren");
    // With a native mimeType in the metadata Drive imports (converts) the upload into that Google type.
    const meta = opts?.convertTo ? { name, parents: [parent.id], mimeType: opts.convertTo } : { name, parents: [parent.id] };
    const url = await c.drive.beginResumableUpload(meta, contentType, size);
    return { provider: "google", session: url, parentId: parent.id, parentPath: parent.path, size, name };
  }

  async putChunk(h: UploadHandle, offset: number, chunk: Uint8Array, last: boolean): Promise<Entry | undefined> {
    if (!last && chunk.length % (256 * 1024) !== 0) throw new Error("Drive chunks must be multiples of 256 KiB");
    const range = chunk.length === 0 ? `bytes */${h.size}` : `bytes ${offset}-${offset + chunk.length - 1}/${h.size}`;
    const res = await currentDriveFetch()(h.session, {
      method: "PUT",
      headers: { "Content-Range": range, "Content-Length": String(chunk.length) },
      body: chunk.length ? (chunk as Uint8Array<ArrayBuffer>) : undefined,
      redirect: "manual",
    });
    if (res.status === 308) return undefined;
    if (!res.ok) throw new ProviderError(`Drive upload ${res.status} (chunk ${range})`, res.status);
    const f = (await res.json()) as DriveFile;
    return toEntry(f, joinPath(h.parentPath ?? "/", f.name));
  }

  async finishUpload(h: UploadHandle, done: Entry | undefined): Promise<Entry> {
    if (!done) throw new ProviderError(`Drive did not complete the upload of ${h.name} after the last chunk`, 500);
    return done;
  }

  async move(entry: Entry, toFolder: Entry): Promise<Entry> {
    const c = await this.ctx();
    const f = await c.drive.getFile(entry.id);
    assertWritable(f, "edit");
    const moved = await c.drive.move(entry.id, toFolder.id, f.parents ?? []);
    return toEntry(moved, joinPath(toFolder.path, moved.name));
  }

  async rename(entry: Entry, newName: string): Promise<Entry> {
    const c = await this.ctx();
    assertWritable(await c.drive.getFile(entry.id), "edit");
    const f = await c.drive.rename(entry.id, newName);
    const i = entry.path.lastIndexOf("/");
    return toEntry(f, joinPath(i <= 0 ? "/" : entry.path.slice(0, i), f.name));
  }

  async trash(entry: Entry): Promise<void> {
    const c = await this.ctx();
    if (entry.id === c.rootId) throw new Error("Refusing to trash the drive root");
    assertWritable(await c.drive.getFile(entry.id), "edit");
    await c.drive.setTrashed(entry.id, true);
  }
}
