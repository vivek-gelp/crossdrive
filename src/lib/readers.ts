/**
 * Content extraction for `read` and `mail_attachment`. Google-native files
 * are exported by Drive; everything else is downloaded and dispatched by
 * mimeType / extension.
 *
 * PDF goes through `unpdf`, which ships a serverless-friendly pdf.js build:
 * it needs none of the browser globals (DOMMatrix, Path2D, ImageData) that
 * pdf.js's default build touches on Vercel's Node runtime. A PDF without a
 * text layer (a scan) raises NoTextError so callers can say so instead of
 * returning an empty string. `scripts/check-pdf.mjs` exercises this under
 * plain `node`, outside Vitest.
 */

export const MAX_READ_BYTES = 25 * 1024 * 1024;

const EXPORT_MIME: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export function exportMimeFor(mimeType: string | undefined): string | undefined {
  return mimeType ? EXPORT_MIME[mimeType] : undefined;
}

export type ReaderKind = "text" | "pdf" | "docx" | "xlsx" | "none";

const TEXT_MIME = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|x-ndjson|javascript|typescript))/;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|log|ini|toml|html?|css|js|ts|py|sh|sql)$/i;

export function pickReader(mimeType: string | undefined, name: string): ReaderKind {
  const mt = (mimeType ?? "").toLowerCase();
  if (mt === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mt === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || /\.docx$/i.test(name)) return "docx";
  if (
    mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mt === "application/vnd.ms-excel" ||
    /\.xlsx?$/i.test(name)
  )
    return "xlsx";
  if (TEXT_MIME.test(mt) || TEXT_EXT.test(name)) return "text";
  return "none";
}

/** The file was parsed but holds no text (a scanned PDF): the message is meant for the caller. */
export class NoTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoTextError";
  }
}

export const NO_TEXT_LAYER = "No extractable text: this PDF has no text layer (scanned pages or images only). OCR is not available; open webViewLink to view it.";

export interface ReadOpts {
  sheet?: string;
  /** xlsx: told every sheet name of the workbook and the one that was read. */
  onSheets?: (sheets: string[], read: string) => void;
}

/** Text of a PDF, pages joined by blank lines. Throws NoTextError when no page has text. */
export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { extractText } = await import("unpdf");
  const r = await extractText(bytes, { mergePages: false });
  const pages = (Array.isArray(r.text) ? r.text : [String(r.text)]).map((p) => p.replace(/[ \t]+\n/g, "\n").trim());
  if (!pages.some((p) => p.length > 0)) throw new NoTextError(NO_TEXT_LAYER);
  return { text: pages.join("\n\n"), pages: r.totalPages };
}

export async function readContent(kind: ReaderKind, bytes: Buffer, opts: ReadOpts): Promise<string> {
  switch (kind) {
    case "text":
      return bytes.toString("utf8");
    case "pdf":
      return (await pdfText(new Uint8Array(bytes))).text;
    case "docx": {
      const mammoth = await import("mammoth");
      const r = await mammoth.extractRawText({ buffer: bytes });
      return r.value;
    }
    case "xlsx": {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(bytes, { type: "buffer" });
      const sheetName = opts.sheet ?? wb.SheetNames[0];
      if (!sheetName || !wb.Sheets[sheetName]) {
        throw new Error(`Sheet "${opts.sheet}" not found. Sheets: ${wb.SheetNames.join(", ")}`);
      }
      opts.onSheets?.(wb.SheetNames, sheetName);
      return XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
    }
    case "none":
      throw new Error("No text reader for this file type");
  }
}

/** Slice `text` for pagination and report whether more remains. */
export function paginate(text: string, offset: number, maxChars: number) {
  const slice = text.slice(offset, offset + maxChars);
  return { text: slice, offset, nextOffset: offset + slice.length, totalChars: text.length, truncated: offset + slice.length < text.length };
}
