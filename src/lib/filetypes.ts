/**
 * MIME type from a file name's extension, for uploads that do not state one (`put` with content / contentBase64).
 * Same table as the bulk uploader (scripts/lib/bulk.mjs).
 */

const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  zip: "application/zip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  dwg: "application/acad",
  kml: "application/vnd.google-earth.kml+xml",
  kmz: "application/vnd.google-earth.kmz",
};

/** MIME type for `name`'s extension, or undefined when the extension is unknown or missing. */
export function mimeTypeForName(name: string): string | undefined {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext ? BY_EXTENSION[ext] : undefined;
}

/** Types that a text `content` upload may carry; anything else falls back to text/plain. */
function isTextual(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "image/svg+xml" || mime.endsWith("+xml");
}

/**
 * Default MIME type of a `put` upload without an explicit mimeType: from the extension for base64 content
 * (application/octet-stream when unknown), from the extension when textual for text content (else text/plain).
 */
export function defaultUploadMime(name: string, kind: "text" | "base64"): string {
  const byName = mimeTypeForName(name);
  if (kind === "base64") return byName ?? "application/octet-stream";
  return byName && isTextual(byName) ? byName : "text/plain";
}
