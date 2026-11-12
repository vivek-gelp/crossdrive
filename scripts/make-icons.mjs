#!/usr/bin/env node
// Regenerates the site icons in public/ from public/brand/crossdrive-mark.svg:
//   favicon.ico (16, 32, 48 as 32-bit BMP, 256 as PNG), icon.svg, icon-32.png, icon-48.png, icon-192.png,
//   icon-512.png and apple-touch-icon.png (180, opaque, padded).
// The generated files are committed; this script only needs to run when the mark changes:
//   node scripts/make-icons.mjs
// It uses `sharp`, which Next.js already installs for image optimisation, so there is no extra dependency.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { encodeIco } from "./lib/ico.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");
// sharp is a dependency of next, not of this package; resolve it from next's location (pnpm does not hoist it).
const requireFromNext = createRequire(createRequire(path.join(root, "package.json")).resolve("next/package.json"));
const sharp = requireFromNext("sharp");

const svg = fs.readFileSync(path.join(pub, "brand", "crossdrive-mark.svg"));
const VIEWBOX = 64;
const APPLE_BG = "#F7F5F0"; // light theme background (app/layout.tsx themeColor)

/** Renders the mark at `size` px square, rasterised at that size (not downscaled) so small sizes stay crisp. */
function render(size) {
  return sharp(svg, { density: (72 * size) / VIEWBOX }).resize(size, size, { fit: "contain", background: "#0000" });
}

async function png(size) {
  return render(size).png({ compressionLevel: 9 }).toBuffer();
}

async function rgba(size) {
  const { data, info } = await render(size).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.height !== size || info.channels !== 4) throw new Error(`unexpected raster ${JSON.stringify(info)}`);
  return data;
}

async function appleTouch() {
  const size = 180;
  const inner = 140; // ~11% padding each side, as iOS crops corners
  const mark = await png(inner);
  const composed = await sharp({ create: { width: size, height: size, channels: 3, background: APPLE_BG } })
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toBuffer();
  return sharp(composed).removeAlpha().png({ compressionLevel: 9 }).toBuffer(); // opaque: iOS fills alpha with black
}

const outputs = {
  "favicon.ico": encodeIco([
    { size: 16, rgba: await rgba(16) },
    { size: 32, rgba: await rgba(32) },
    { size: 48, rgba: await rgba(48) },
    { size: 256, png: await png(256) },
  ]),
  "icon.svg": svg,
  "icon-32.png": await png(32),
  "icon-48.png": await png(48),
  "icon-192.png": await png(192),
  "icon-512.png": await png(512),
  "apple-touch-icon.png": await appleTouch(),
};

for (const [name, buf] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(pub, name), buf);
  console.log(`public/${name}  ${buf.length} bytes`);
}
