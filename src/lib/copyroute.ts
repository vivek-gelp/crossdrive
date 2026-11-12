/**
 * How a cross-account Google -> Google copy is made:
 *
 * - "share": the source account is writable and may share the file. It grants the destination account temporary
 *   `reader` access to that one file (tempgrant.ts), the destination copies it server-side with files.copy, and the
 *   grant is removed. Google-native files keep their type, no bytes pass through this server.
 * - "stream": the source account is read-only, or the file cannot be shared for copying. The file is downloaded as
 *   the source account and uploaded as the destination account (providers/transfer.ts); nothing is written to the
 *   source account. Google Docs/Sheets/Slides are exported and imported back (comments and history are lost).
 */
import { isAccountReadOnly } from "./access";
import { ctxFor } from "./ctx";
import { FOLDER_MIME, SHORTCUT_MIME, type DriveFile } from "./drive";
import { isGoogleNativeMime } from "./naming";
import { GOOGLE_IMPORTS } from "./providers/google";

export function readOnlySourceReason(label: string): string {
  return `source account ${label} is read-only, so no permission is created on it`;
}

/** Why `f` cannot be copied through a temporary reader grant, or undefined when it can. */
export function shareBlocker(f: DriveFile): string | undefined {
  if (f.copyRequiresWriterPermission) return `"${f.name}" only lets writers copy it (copyRequiresWriterPermission), and Crossdrive never grants writer access for a copy`;
  if (f.capabilities?.canShare === false) return `the source account may not change sharing of "${f.name}"`;
  return undefined;
}

/**
 * Why a cross-account Google -> Google copy must stream (undefined: the share path is allowed). Checks the source
 * account's mode fresh from the store and, when `fileId` is given, the file's own copy restrictions.
 */
export async function googleStreamReason(srcLabel: string, fileId?: string, file?: DriveFile): Promise<string | undefined> {
  if (await isAccountReadOnly(srcLabel)) return readOnlySourceReason(srcLabel);
  if (!fileId && !file) return undefined;
  const f = file ?? (await (await ctxFor(srcLabel)).drive.getFile(fileId!));
  return shareBlocker(f);
}

/** Why `file` cannot be streamed (no export/import path, or a shortcut), or undefined when it can. */
export function unstreamable(file: Pick<DriveFile, "mimeType">): string | undefined {
  if (file.mimeType === SHORTCUT_MIME) return "Google Drive shortcut: not copied when streaming (it points at an item of the source account)";
  if (isGoogleNativeMime(file.mimeType) && file.mimeType !== FOLDER_MIME && !GOOGLE_IMPORTS.has(file.mimeType)) {
    return `Google-native type ${file.mimeType} has no export/import path; copy it from a writable source account, or by hand`;
  }
  return undefined;
}
