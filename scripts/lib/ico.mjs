// Minimal ICO encoder (no dependencies). Each image is either a PNG (stored as is, which Windows Vista+ and every
// current browser read) or raw RGBA pixels, stored as a 32-bit BMP/DIB entry with an empty AND mask, which every
// ICO reader understands. Layout: ICONDIR (6 bytes), one ICONDIRENTRY (16 bytes) per image, then the image data.

/**
 * @typedef {{ size: number, png: Buffer } | { size: number, rgba: Buffer }} IcoImage
 *   `size` is the pixel width and height (1..256); `rgba` is size*size*4 bytes, top row first.
 */

/** Encodes raw RGBA pixels as the DIB payload of an ICO entry (BITMAPINFOHEADER, BGRA bottom-up, AND mask). */
export function rgbaToDib(size, rgba) {
  if (rgba.length !== size * size * 4) throw new Error(`expected ${size * size * 4} RGBA bytes, got ${rgba.length}`);
  const maskRow = Math.ceil(size / 32) * 4; // 1 bit per pixel, rows padded to 4 bytes
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight: XOR bitmap + AND mask
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20); // biSizeImage
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2]; // B
      pixels[d + 1] = rgba[s + 1]; // G
      pixels[d + 2] = rgba[s]; // R
      pixels[d + 3] = rgba[s + 3]; // A
    }
  }
  const mask = Buffer.alloc(maskRow * size); // all zero: alpha channel decides transparency
  return Buffer.concat([header, pixels, mask]);
}

/** @param {IcoImage[]} images */
export function encodeIco(images) {
  if (images.length === 0 || images.length > 0xffff) throw new Error("an ICO needs 1..65535 images");
  const payloads = images.map((img) => {
    if (!Number.isInteger(img.size) || img.size < 1 || img.size > 256) throw new Error(`bad icon size ${img.size}`);
    return "png" in img ? img.png : rgbaToDib(img.size, img.rgba);
  });
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type 1 = icon
  dir.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map((img, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size === 256 ? 0 : img.size, 0); // 0 means 256
    e.writeUInt8(img.size === 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2); // no palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(payloads[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += payloads[i].length;
    return e;
  });
  return Buffer.concat([dir, ...entries, ...payloads]);
}

/** Reads back the directory of an ICO file: one { size, bytes, offset, png } per entry. */
export function readIcoDirectory(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an ICO file");
  const count = buf.readUInt16LE(4);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + 16 * i;
    const size = buf.readUInt8(o) || 256;
    const bytes = buf.readUInt32LE(o + 8);
    const offset = buf.readUInt32LE(o + 12);
    const png = buf.subarray(offset, offset + 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    out.push({ size, bytes, offset, png });
  }
  return out;
}
