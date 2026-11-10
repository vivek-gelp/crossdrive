#!/usr/bin/env node
/**
 * Plain-Node check of the PDF reader, outside Vitest: Vercel runs the server
 * on Node without browser globals (no DOMMatrix / Path2D / ImageData), and a
 * pdf.js build that expects them fails there while a test runner may hide it.
 *
 *   node scripts/check-pdf.mjs [file.pdf ...]
 *
 * Without arguments it reads the two fixtures (a text PDF and a scanned one).
 * Exits 1 when extraction throws anything but the "no text layer" error.
 * Uses Node's built-in TypeScript type stripping (Node 22.6+ / 24) to load
 * src/lib/readers.ts as the server does.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { pdfText, NoTextError } = await import(pathToFileURL(path.join(here, "..", "src", "lib", "readers.ts")).href);

const files = process.argv.slice(2);
if (files.length === 0) {
  const fixtures = path.join(here, "..", "src", "lib", "testing", "fixtures");
  files.push(path.join(fixtures, "sample.pdf"), path.join(fixtures, "scanned.pdf"));
}

console.log(`node ${process.version}; DOMMatrix defined: ${"DOMMatrix" in globalThis}; Path2D defined: ${"Path2D" in globalThis}`);
let failed = false;
for (const f of files) {
  const bytes = new Uint8Array(fs.readFileSync(f));
  try {
    const { text, pages } = await pdfText(bytes);
    const preview = text.replace(/\s+/g, " ").slice(0, 120);
    console.log(`OK   ${path.basename(f)}: ${pages} page(s), ${text.length} chars: "${preview}${text.length > 120 ? "..." : ""}"`);
  } catch (e) {
    if (e instanceof NoTextError) console.log(`OK   ${path.basename(f)}: ${e.message}`);
    else {
      failed = true;
      console.log(`FAIL ${path.basename(f)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
process.exit(failed ? 1 : 0);
