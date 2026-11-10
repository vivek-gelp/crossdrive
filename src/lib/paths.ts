import { FOLDER_MIME, type DriveClient, type DriveFile } from "./drive";

/**
 * Three path forms:
 *  - `label:/Projects/Sub`       walks folder names from the account's My Drive root;
 *  - `label:~shared/Top/Sub`     `Top` is a folder shared with the account ("Shared with me",
 *                                matched by exact name), then folder names are walked below it;
 *  - `label:drive/<Drive>/Sub`   `<Drive>` is a Shared Drive the account is a member of
 *                                (matched by exact name via drives.list), then folders are walked.
 * Results are cached for 5 minutes.
 */

export const SHARED_PREFIX = "~shared";
export const DRIVE_PREFIX = "drive";

export interface ParsedPath {
  label: string | undefined;
  segments: string[];
  /** True for the `label:~shared/...` form. */
  shared: boolean;
  /** True for the `label:drive/<Drive name>/...` form. */
  drive: boolean;
}

export function parsePathArg(input: string): ParsedPath {
  let label: string | undefined;
  let rest = input.trim();
  const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(rest);
  if (m) {
    label = m[1];
    rest = m[2] ?? "";
  }
  const segments = rest.split("/").map((s) => s.trim()).filter(Boolean);
  if (segments.some((s) => s === "..")) throw new Error('Path segments may not contain ".."');
  const first = segments[0]?.toLowerCase();
  const shared = first === SHARED_PREFIX;
  const drive = first === DRIVE_PREFIX;
  if (shared || drive) segments.shift();
  return { label, segments, shared, drive };
}

async function findFolder(drive: DriveClient, parentId: string, name: string): Promise<DriveFile | undefined> {
  // Walk listChildren (paged) so names match case-insensitively; Drive's
  // `name =` query is case-sensitive.
  let pageToken: string | undefined;
  const target = name.toLowerCase();
  do {
    const page = await drive.listChildren(parentId, pageToken);
    const hit = page.files.find((f) => f.mimeType === FOLDER_MIME && f.name.toLowerCase() === target);
    if (hit) return hit;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return undefined;
}

export async function resolvePath(drive: DriveClient, segments: string[], rootId = "root"): Promise<string> {
  let current = rootId;
  const walked: string[] = [];
  for (const seg of segments) {
    const hit = await findFolder(drive, current, seg);
    if (!hit) {
      throw new Error(`Folder "${seg}" not found under /${walked.join("/")}`);
    }
    walked.push(hit.name);
    current = hit.id;
  }
  return current;
}

/**
 * `~shared/<Top>/<Sub>/...`: the top folder is looked up among folders shared
 * with the account by exact (case-insensitive) name, the rest is walked as usual.
 */
export async function resolveSharedPath(drive: DriveClient, segments: string[]): Promise<string> {
  const [topName, ...rest] = segments;
  if (!topName) {
    throw new Error(`A ${SHARED_PREFIX} path needs a folder name: label:${SHARED_PREFIX}/<Top folder>/... (use the shared tool to list them)`);
  }
  const top = await drive.findSharedFolderByName(topName);
  if (!top) {
    throw new Error(`Folder "${topName}" is not among the folders shared with this account (use the shared tool to list them, or pass folderId)`);
  }
  return resolvePath(drive, rest, top.id);
}

/**
 * `drive/<Drive name>/<Sub>/...`: the Shared Drive is matched by exact
 * (case-insensitive) name via drives.list; its id doubles as its root folder id.
 */
export async function resolveDrivePath(drive: DriveClient, segments: string[]): Promise<string> {
  const [driveName, ...rest] = segments;
  if (!driveName) {
    throw new Error(`A Shared Drive path needs a drive name: label:${DRIVE_PREFIX}/<Drive name>/... (use the drives tool to list them)`);
  }
  const sd = await drive.findDriveByName(driveName);
  if (!sd) {
    throw new Error(`"${driveName}" is not a Shared Drive this account is a member of (use the drives tool to list them, or pass folderId)`);
  }
  return resolvePath(drive, rest, sd.id);
}

const TTL_MS = 5 * 60 * 1000;

export class PathResolver {
  private readonly cache = new Map<string, { at: number; id: string }>();
  private readonly folders = new Map<string, { at: number; file: DriveFile }>();

  constructor(private readonly now: () => number = Date.now) {}

  async resolve(label: string, drive: DriveClient, segments: string[], rootId = "root", shared = false, sharedDrive = false): Promise<string> {
    const base = shared ? SHARED_PREFIX : sharedDrive ? DRIVE_PREFIX : rootId;
    const key = `${label}:${base}:/${segments.map((s) => s.toLowerCase()).join("/")}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.id;
    const id = shared
      ? await resolveSharedPath(drive, segments)
      : sharedDrive
        ? await resolveDrivePath(drive, segments)
        : await resolvePath(drive, segments, rootId);
    this.cache.set(key, { at: this.now(), id });
    return id;
  }

  private async folder(label: string, drive: DriveClient, id: string): Promise<DriveFile> {
    const key = `${label}:${id}`;
    const hit = this.folders.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.file;
    const file = await drive.getFile(id);
    this.folders.set(key, { at: this.now(), file });
    return file;
  }

  /**
   * `label:/A/B` for the given file by walking its parents up to My Drive
   * root. Items inside a Shared Drive (driveId set) walk up to the drive's
   * root folder and become `label:drive/<Drive name>/A/B`. When the chain
   * ends elsewhere (no parents, or a parent the account cannot see) the item
   * was reached via "Shared with me" and the path is `label:~shared/A/B`.
   */
  async displayPath(label: string, drive: DriveClient, fileId: string, rootId: string, file?: DriveFile): Promise<string> {
    const names: string[] = [];
    let current: DriveFile | undefined = file ?? (await this.folder(label, drive, fileId));
    let reachedRoot = false;
    let driveName: string | undefined;
    let guard = 0;
    while (current && guard++ < 32) {
      if (current.id === rootId || current.id === "root") {
        reachedRoot = true;
        break;
      }
      if (current.driveId && current.id === current.driveId) {
        driveName = current.name;
        break;
      }
      names.unshift(current.name);
      const parentId: string | undefined = current.parents?.[0];
      if (!parentId) break;
      if (parentId === rootId || parentId === "root") {
        reachedRoot = true;
        break;
      }
      try {
        current = await this.folder(label, drive, parentId);
      } catch {
        break;
      }
    }
    if (driveName !== undefined) return `${label}:${DRIVE_PREFIX}/${[driveName, ...names].join("/")}`;
    return reachedRoot ? `${label}:/${names.join("/")}` : `${label}:${SHARED_PREFIX}/${names.join("/")}`;
  }
}

export const pathResolver = new PathResolver();
