/**
 * What a name becomes on the destination provider. Illegal characters are
 * replaced (deterministically, so a resumed transfer finds what it created
 * earlier); names that are too long are not truncated but reported.
 *
 * OneDrive / SharePoint (support.microsoft.com "Restrictions and limitations
 * in OneDrive and SharePoint"): no " * : < > ? / \ |, no trailing space or
 * period, reserved names .lock CON PRN AUX NUL COM0-9 LPT0-9 desktop.ini,
 * nothing starting with ~$, no _vti_ anywhere; full decoded path ≤ 400.
 * Dropbox (help.dropbox.com "file names"): / and \ never allowed, no
 * trailing space; < > : " | ? * and a trailing period are allowed but cause
 * trouble on Windows (reported as warnings); full path < 260 characters.
 * Google Drive accepts any name.
 */
import type { Capabilities, ProviderKind } from "./types";

export interface TargetName {
  name: string;
  /** Why the name had to change (absent when it did not). */
  renamed?: string;
  /** Allowed but likely to cause trouble (Dropbox on Windows). */
  warning?: string;
}

const ONEDRIVE_ILLEGAL = /["*:<>?/\\|]/g;
const ONEDRIVE_RESERVED = /^(\.lock|con|prn|aux|nul|com[0-9]|lpt[0-9]|desktop\.ini)$/i;
const ONEDRIVE_RESERVED_BASE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i;

export function targetName(kind: ProviderKind, name: string): TargetName {
  let out = name;
  const reasons: string[] = [];
  if (kind === "microsoft") {
    if (/["*:<>?/\\|]/.test(out)) {
      out = out.replace(ONEDRIVE_ILLEGAL, "_");
      reasons.push('characters " * : < > ? / \\ | are not allowed on OneDrive');
    }
    if (/[ .]+$/.test(out)) {
      out = out.replace(/[ .]+$/, "") || "_";
      reasons.push("OneDrive names cannot end with a space or period");
    }
    if (out.startsWith("~$")) {
      out = `_${out.slice(1)}`;
      reasons.push("OneDrive names cannot start with ~$");
    }
    if (/_vti_/i.test(out)) {
      out = out.replace(/_vti_/gi, "_vti-");
      reasons.push("OneDrive names cannot contain _vti_");
    }
    if (ONEDRIVE_RESERVED.test(out) || ONEDRIVE_RESERVED_BASE.test(out)) {
      const dot = out.indexOf(".", 1);
      out = dot > 0 ? `${out.slice(0, dot)}_${out.slice(dot)}` : `${out}_`;
      reasons.push("reserved name on OneDrive");
    }
  } else if (kind === "dropbox") {
    if (/[/\\]/.test(out)) {
      out = out.replace(/[/\\]/g, "_");
      reasons.push("/ and \\ are not allowed on Dropbox");
    }
    if (/ +$/.test(out)) {
      out = out.replace(/ +$/, "") || "_";
      reasons.push("Dropbox names cannot end with a space");
    }
  }
  const r: TargetName = { name: out };
  if (reasons.length) r.renamed = reasons.join("; ");
  if (kind === "dropbox" && (/[<>:"|?*]/.test(out) || /\.$/.test(out))) {
    r.warning = 'contains < > : " | ? * or ends with a period: allowed on Dropbox but renamed by its Windows app';
  }
  return r;
}

/** Problems that stop an item from being created on the destination at all. */
export function limitProblem(caps: Capabilities, name: string, destPath: string, size: number | undefined): string | undefined {
  if (name.length > caps.maxNameChars) return `name is ${name.length} characters; the destination allows ${caps.maxNameChars}`;
  if (caps.maxPathChars !== undefined && destPath.length > caps.maxPathChars) return `path is ${destPath.length} characters; the destination allows ${caps.maxPathChars}`;
  if (size !== undefined && size > caps.maxFileBytes) return `file is ${size} bytes; the destination accepts at most ${caps.maxFileBytes}`;
  return undefined;
}
