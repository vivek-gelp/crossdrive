// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { exportMimeFor, MAX_READ_BYTES, NO_TEXT_LAYER, NoTextError, paginate, pdfText, pickReader, readContent } from "./readers";

const fixture = (name: string) => readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url));

describe("exportMimeFor", () => {
  it("maps Google-native types to export mimes", () => {
    expect(exportMimeFor("application/vnd.google-apps.document")).toBe("text/plain");
    expect(exportMimeFor("application/vnd.google-apps.spreadsheet")).toBe("text/csv");
    expect(exportMimeFor("application/vnd.google-apps.presentation")).toBe("text/plain");
    expect(exportMimeFor("application/pdf")).toBeUndefined();
  });
});

describe("pickReader", () => {
  it("dispatches by mimeType", () => {
    expect(pickReader("application/pdf", "x.pdf")).toBe("pdf");
    expect(pickReader("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "x.docx")).toBe("docx");
    expect(pickReader("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x.xlsx")).toBe("xlsx");
    expect(pickReader("text/plain", "x.txt")).toBe("text");
    expect(pickReader("text/markdown", "x.md")).toBe("text");
    expect(pickReader("application/json", "x.json")).toBe("text");
    expect(pickReader("text/csv", "x.csv")).toBe("text");
    expect(pickReader("image/png", "x.png")).toBe("none");
    expect(pickReader("application/octet-stream", "notes.md")).toBe("text");
  });
});

describe("readContent", () => {
  it("returns raw text for text types", async () => {
    const out = await readContent("text", Buffer.from("hello"), {});
    expect(out).toBe("hello");
  });
  it("converts xlsx first sheet to CSV, or a named sheet", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], [1, 2]]), "One");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["z"], [9]]), "Two");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect((await readContent("xlsx", buf, {})).trim()).toBe("a,b\n1,2");
    expect((await readContent("xlsx", buf, { sheet: "Two" })).trim()).toBe("z\n9");
    let told: unknown;
    await readContent("xlsx", buf, { onSheets: (all, read) => (told = { all, read }) });
    expect(told).toEqual({ all: ["One", "Two"], read: "One" });
  });
  it("extracts text from a minimal PDF without browser globals", async () => {
    expect("DOMMatrix" in globalThis).toBe(false);
    const pdf = minimalPdf("Hello Vault");
    const out = await readContent("pdf", pdf, {});
    expect(out).toContain("Hello Vault");
  });
  it("reads the multi-page fixture, pages separated by a blank line, and paginates by offset", async () => {
    const r = await pdfText(new Uint8Array(fixture("sample.pdf")));
    expect(r.pages).toBe(2);
    expect(r.text).toBe("Example PPA page one\n\nSecond page of the agreement");
    const full = await readContent("pdf", fixture("sample.pdf"), {});
    const first = paginate(full, 0, 20);
    expect(first).toEqual({ text: "Example PPA page one", offset: 0, nextOffset: 20, totalChars: full.length, truncated: true });
    const rest = paginate(full, first.nextOffset, 10_000);
    expect(rest.text).toBe("\n\nSecond page of the agreement");
    expect(rest.truncated).toBe(false);
  });
  it("reports a scanned PDF (no text layer) with a clear message instead of empty text", async () => {
    await expect(readContent("pdf", fixture("scanned.pdf"), {})).rejects.toBeInstanceOf(NoTextError);
    await expect(readContent("pdf", fixture("scanned.pdf"), {})).rejects.toThrow(NO_TEXT_LAYER);
    expect(NO_TEXT_LAYER).toMatch(/^No extractable text/);
  });
  it("exposes the 25 MB cap", () => {
    expect(MAX_READ_BYTES).toBe(25 * 1024 * 1024);
  });
});

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
