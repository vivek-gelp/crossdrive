/**
 * `tree`: a folder manifest. Breadth-first below a starting folder down to
 * `depth` levels (1-4); for every folder its direct file count, total bytes
 * of those files, newest modifiedTime and number of subfolders. Capped at
 * MAX_TREE_NODES folders (truncated=true). Read-only.
 */
import type { Ctx } from "./ctx";
import { escapeQ, FOLDER_MIME } from "./drive";
import { pathResolver } from "./paths";

export const MAX_TREE_NODES = 2000;
export const MAX_TREE_DEPTH = 4;

export interface TreeNode {
  id: string;
  path: string;
  /** 0 for the starting folder. */
  depth: number;
  fileCount: number;
  totalBytes: number;
  newestModified?: string;
  folderCount: number;
  /** True when the folder has subfolders that were not walked (depth limit or node cap). */
  notExpanded?: boolean;
}

export interface TreeResult {
  account: string;
  root: { id: string; path: string };
  depth: number;
  folders: TreeNode[];
  totals: { folders: number; files: number; bytes: number; newestModified?: string };
  truncated: boolean;
}

const CHILD_FIELDS = "id,name,mimeType,size,modifiedTime";

export async function buildTree(c: Ctx, rootId: string, depth: number, cap = MAX_TREE_NODES): Promise<TreeResult> {
  const d = Math.min(Math.max(Math.trunc(depth), 1), MAX_TREE_DEPTH);
  const rootPath = await pathResolver.displayPath(c.account.label, c.drive, rootId, c.rootId);
  const folders: TreeNode[] = [];
  let truncated = false;
  let queue: { id: string; path: string; depth: number }[] = [{ id: rootId, path: rootPath, depth: 0 }];
  while (queue.length) {
    const next: typeof queue = [];
    for (const item of queue) {
      if (folders.length >= cap) {
        truncated = true;
        break;
      }
      const node: TreeNode = { id: item.id, path: item.path, depth: item.depth, fileCount: 0, totalBytes: 0, folderCount: 0 };
      folders.push(node);
      const subfolders: { id: string; name: string }[] = [];
      let pageToken: string | undefined;
      do {
        const page = await c.drive.listFiles({ q: `'${escapeQ(item.id)}' in parents and trashed = false`, pageSize: 1000, pageToken, fields: CHILD_FIELDS });
        for (const f of page.files) {
          if (f.mimeType === FOLDER_MIME) {
            subfolders.push({ id: f.id, name: f.name });
            continue;
          }
          node.fileCount++;
          node.totalBytes += f.size ? Number(f.size) : 0;
          if (f.modifiedTime && (!node.newestModified || f.modifiedTime > node.newestModified)) node.newestModified = f.modifiedTime;
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      node.folderCount = subfolders.length;
      if (subfolders.length && item.depth + 1 > d) node.notExpanded = true;
      else for (const s of subfolders.sort((x, y) => x.name.localeCompare(y.name))) next.push({ id: s.id, path: `${item.path.replace(/\/$/, "")}/${s.name}`, depth: item.depth + 1 });
    }
    if (truncated) break;
    queue = next;
  }
  const totals = {
    folders: folders.length,
    files: folders.reduce((n, f) => n + f.fileCount, 0),
    bytes: folders.reduce((n, f) => n + f.totalBytes, 0),
    newestModified: folders.reduce<string | undefined>((m, f) => (f.newestModified && (!m || f.newestModified > m) ? f.newestModified : m), undefined),
  };
  return { account: c.account.label, root: { id: rootId, path: rootPath }, depth: d, folders, totals, truncated };
}
