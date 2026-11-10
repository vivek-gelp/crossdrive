/**
 * Provider-neutral storage interface used by the cloud_* tools and the
 * cross-provider transfer engine. Google Drive, OneDrive (Microsoft Graph)
 * and Dropbox each implement it in their own adapter.
 *
 * Addressing: an `Entry` carries the provider's stable `id` (Drive file id,
 * Graph driveItem id, Dropbox `id:...`) and a slash path relative to the
 * account root (`/A/B/file.txt`, root is `/`). Paths are informational for
 * Google (names are not unique there); ids are what writes act on.
 *
 * Uploads always go through a chunked session (begin → putChunk… → finish)
 * so a transfer never holds more than one chunk in memory.
 */

export type ProviderKind = "google" | "microsoft" | "dropbox";

/**
 * Content hashes a provider can report:
 * - `md5`: Google Drive `md5Checksum` (binary files only);
 * - `sha1` / `sha256`: OneDrive personal (`file.hashes.sha1Hash` / `sha256Hash`), upper-case hex normalised to lower;
 * - `quickXor`: OneDrive `file.hashes.quickXorHash` (base64, personal and work/school);
 * - `dropbox`: Dropbox `content_hash` (hex, SHA-256 over SHA-256s of 4 MiB blocks).
 */
export type HashKind = "md5" | "sha1" | "sha256" | "quickXor" | "dropbox";
export type Hashes = Partial<Record<HashKind, string>>;

export interface Entry {
  id: string;
  name: string;
  /** Slash path from the account root, `/` for the root itself. Best effort for Google. */
  path: string;
  isFolder: boolean;
  /** Bytes; undefined for folders and Google-native files. */
  size?: number;
  /** RFC 3339. */
  modified?: string;
  hash?: Hashes;
  mimeType?: string;
  /** Google only: Docs/Sheets/Slides/... that have no bytes of their own and must be exported. */
  googleNative?: boolean;
  /** Google only: a shortcut (not transferred). */
  shortcut?: boolean;
}

export interface Page {
  entries: Entry[];
  /** Opaque; pass back to `list` for the next page. */
  nextPageToken?: string;
}

export interface Download {
  stream: AsyncIterable<Uint8Array>;
  /** Byte count of the stream when known (exports are fully known). */
  size?: number;
  contentType: string;
  /** Set when a Google-native file was exported: e.g. `docx`. */
  exportedAs?: string;
  /** Name the bytes should get at the destination (export adds an extension). */
  name: string;
}

/** Serializable upload session state; it goes into the transfer cursor so a big file can span slices. */
export interface UploadHandle {
  provider: ProviderKind;
  /** Google / OneDrive: the pre-authorised session URL. Dropbox: the session id. */
  session: string;
  /** Dropbox: the commit path. Google/OneDrive: unused. */
  commitPath?: string;
  /** Destination folder (id and path) the file is created in. */
  parentId?: string;
  parentPath?: string;
  size: number;
  name: string;
}

export interface Capabilities {
  /** Hash kinds this provider reports on files (and that the transfer can compare against). */
  hashes: HashKind[];
  /** Upload chunk size: every chunk but the last has exactly this many bytes. */
  chunkBytes: number;
  /** Largest file the provider accepts through the API. */
  maxFileBytes: number;
  /** Longest full path the provider accepts (characters), when it documents one. */
  maxPathChars?: number;
  /** Longest single name component. */
  maxNameChars: number;
  /** True when sibling names must be unique (OneDrive, Dropbox). Google allows duplicates. */
  uniqueNames: boolean;
  /** True when download accepts an HTTP Range (needed to resume a file mid-way). */
  rangeDownload: boolean;
}

export interface StorageProvider {
  readonly kind: ProviderKind;
  readonly label: string;
  readonly caps: Capabilities;
  root(): Promise<Entry>;
  /** Resolve a slash path (`/A/b.txt`, `/` for the root). Throws when missing. */
  stat(path: string): Promise<Entry>;
  statId(id: string): Promise<Entry>;
  /** Direct child of `folder` named `name` (case-insensitive where the provider is), or undefined. */
  child(folder: Entry, name: string): Promise<Entry | undefined>;
  list(folder: Entry, pageToken?: string): Promise<Page>;
  find(query: string, limit: number, under?: Entry): Promise<Entry[]>;
  /** Create a folder; returns the existing folder when one with that name already exists. */
  mkdir(parent: Entry, name: string): Promise<Entry>;
  /** Stream a file's bytes from `offset`. Google-native files are exported (offset must be 0). */
  download(entry: Entry, offset?: number): Promise<Download>;
  /** Open an upload session for a new file `name` in `parent`; never overwrites. */
  beginUpload(parent: Entry, name: string, size: number, contentType: string): Promise<UploadHandle>;
  /**
   * Send one chunk at `offset`. Returns the created Entry when the provider
   * finished the file with this chunk (Google, OneDrive on the last chunk),
   * otherwise undefined.
   */
  putChunk(h: UploadHandle, offset: number, chunk: Uint8Array, last: boolean): Promise<Entry | undefined>;
  /** Close the session after the last chunk (Dropbox commit). Providers that finish on the last chunk return `done`. */
  finishUpload(h: UploadHandle, done: Entry | undefined): Promise<Entry>;
  move(entry: Entry, toFolder: Entry): Promise<Entry>;
  rename(entry: Entry, newName: string): Promise<Entry>;
  /** Recoverable delete only (Drive trash, OneDrive recycle bin, Dropbox deleted files). */
  trash(entry: Entry): Promise<void>;
}

/** Raised by the adapters with the HTTP status so callers can tell conflicts and transient failures apart. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function isConflict(e: unknown): boolean {
  return e instanceof ProviderError && e.status === 409;
}

export function isTransientError(e: unknown): boolean {
  return e instanceof ProviderError && (e.status === 429 || e.status >= 500);
}

export function joinPath(parent: string, name: string): string {
  return parent === "/" || parent === "" ? `/${name}` : `${parent.replace(/\/$/, "")}/${name}`;
}
