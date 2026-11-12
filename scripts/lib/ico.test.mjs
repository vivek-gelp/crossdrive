import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeIco, readIcoDirectory, rgbaToDib } from "./ico.mjs";

describe("encodeIco", () => {
  it("writes a directory entry per image with correct offsets, 256 stored as 0", () => {
    const fakePng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(10)]);
    const ico = encodeIco([
      { size: 2, rgba: Buffer.alloc(16, 0xff) },
      { size: 256, png: fakePng },
    ]);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt8(6 + 16)).toBe(0);
    const dir = readIcoDirectory(ico);
    expect(dir.map((e) => [e.size, e.png])).toEqual([
      [2, false],
      [256, true],
    ]);
    expect(dir[0].offset).toBe(6 + 32);
    expect(dir[1].offset).toBe(dir[0].offset + dir[0].bytes);
    expect(ico.length).toBe(dir[1].offset + dir[1].bytes);
  });

  it("stores DIB pixels bottom-up as BGRA with a double-height header and a padded AND mask", () => {
    // 2x2: top row red, green; bottom row blue, transparent
    const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]);
    const dib = rgbaToDib(2, rgba);
    expect(dib.readInt32LE(4)).toBe(2);
    expect(dib.readInt32LE(8)).toBe(4);
    expect(dib.readUInt16LE(14)).toBe(32);
    expect([...dib.subarray(40, 48)]).toEqual([255, 0, 0, 255, 0, 0, 0, 0]); // bottom row first: blue, transparent
    expect([...dib.subarray(48, 56)]).toEqual([0, 0, 255, 255, 0, 255, 0, 255]); // then red, green
    expect(dib.length).toBe(40 + 16 + 4 * 2);
  });

  it("rejects bad sizes and pixel buffers", () => {
    expect(() => encodeIco([])).toThrow();
    expect(() => encodeIco([{ size: 300, rgba: Buffer.alloc(0) }])).toThrow(/size/);
    expect(() => rgbaToDib(2, Buffer.alloc(3))).toThrow(/RGBA/);
  });
});

describe("public/favicon.ico", () => {
  it("holds 16, 32 and 48 px BMP images and a 256 px PNG", () => {
    const dir = readIcoDirectory(fs.readFileSync(new URL("../../public/favicon.ico", import.meta.url)));
    expect(dir.map((e) => [e.size, e.png])).toEqual([
      [16, false],
      [32, false],
      [48, false],
      [256, true],
    ]);
  });
});
