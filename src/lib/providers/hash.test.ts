import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DROPBOX_BLOCK, DropboxContentHash, hashesMatch, MultiHasher, QuickXorHash } from "./hash";

/** Straight port of Microsoft's reference QuickXorHash (C#, three 64-bit cells), used to check the folded version. */
function referenceQuickXor(data: Uint8Array): string {
  const width = 160;
  const shift = 11;
  const cells = [0n, 0n, 0n];
  const U64 = (1n << 64n) - 1n;
  let shiftSoFar = 0;
  let vectorArrayIndex = Math.floor(shiftSoFar / 64);
  let vectorOffset = shiftSoFar % 64;
  const iterations = Math.min(data.length, width);
  for (let i = 0; i < iterations; i++) {
    const isLastCell = vectorArrayIndex === cells.length - 1;
    const bitsInVectorCell = isLastCell ? width % 64 : 64;
    if (vectorOffset <= bitsInVectorCell - 8) {
      for (let j = i; j < data.length; j += width) cells[vectorArrayIndex] = (cells[vectorArrayIndex]! ^ (BigInt(data[j]!) << BigInt(vectorOffset))) & U64;
    } else {
      const index1 = vectorArrayIndex;
      const index2 = isLastCell ? 0 : vectorArrayIndex + 1;
      const low = bitsInVectorCell - vectorOffset;
      let xored = 0;
      for (let j = i; j < data.length; j += width) xored ^= data[j]!;
      cells[index1] = (cells[index1]! ^ (BigInt(xored) << BigInt(vectorOffset))) & U64;
      cells[index2] = (cells[index2]! ^ (BigInt(xored) >> BigInt(low))) & U64;
    }
    vectorOffset += shift;
    while (vectorOffset >= bitsInVectorCell) {
      vectorArrayIndex = isLastCell ? 0 : vectorArrayIndex + 1;
      vectorOffset -= bitsInVectorCell;
    }
  }
  shiftSoFar = (shiftSoFar + shift * (data.length % width)) % width;
  const out = new Uint8Array(20);
  for (let c = 0; c < 3; c++) for (let b = 0; b < 8 && c * 8 + b < 20; b++) out[c * 8 + b] = Number((cells[c]! >> BigInt(8 * b)) & 0xffn);
  let len = BigInt(data.length);
  for (let i = 0; i < 8; i++) {
    out[12 + i] = out[12 + i]! ^ Number(len & 0xffn);
    len >>= 8n;
  }
  return Buffer.from(out).toString("base64");
}

describe("QuickXorHash", () => {
  it("matches published test vectors", () => {
    const vectors: [string, string][] = [
      ["", "AAAAAAAAAAAAAAAAAAAAAAAAAAA="],
      ["Sg==", "SgAAAAAAAAAAAAAAAQAAAAAAAAA="],
      ["tbQ=", "taAFAAAAAAAAAAAAAgAAAAAAAAA="],
      ["0pZP", "0rDEEwAAAAAAAAAAAwAAAAAAAAA="],
      ["jRRDVA==", "jaDAEKgAAAAAAAAABAAAAAAAAAA="],
      ["eAV52qE=", "eChAHrQRCgAAAAAABQAAAAAAAAA="],
    ];
    for (const [input, want] of vectors) {
      expect(new QuickXorHash().update(Buffer.from(input, "base64")).digestBase64()).toBe(want);
    }
  });

  it("agrees with the reference implementation on long inputs, fed in odd pieces", () => {
    for (const n of [159, 160, 161, 1000, 4099]) {
      const data = randomBytes(n);
      const h = new QuickXorHash();
      for (let i = 0; i < n; i += 37) h.update(data.subarray(i, i + 37));
      expect(h.digestBase64()).toBe(referenceQuickXor(data));
    }
  });
});

describe("DropboxContentHash", () => {
  it("is sha256 over per-4MiB-block sha256 digests", () => {
    const data = randomBytes(DROPBOX_BLOCK + 1000);
    const want = createHash("sha256")
      .update(Buffer.concat([createHash("sha256").update(data.subarray(0, DROPBOX_BLOCK)).digest(), createHash("sha256").update(data.subarray(DROPBOX_BLOCK)).digest()]))
      .digest("hex");
    const h = new DropboxContentHash();
    for (let i = 0; i < data.length; i += 1_000_000) h.update(data.subarray(i, i + 1_000_000));
    expect(h.digestHex()).toBe(want);
  });

  it("hashes an empty file as sha256 of nothing", () => {
    expect(new DropboxContentHash().digestHex()).toBe(createHash("sha256").digest("hex"));
  });
});

describe("MultiHasher / hashesMatch", () => {
  it("computes several kinds in one pass and compares only common kinds", () => {
    const m = new MultiHasher(["md5", "quickXor"]);
    m.update(Buffer.from("hello"));
    const d = m.digest();
    expect(d.md5).toBe(createHash("md5").update("hello").digest("hex"));
    expect(hashesMatch(d, { md5: d.md5!.toUpperCase() })).toBe(true);
    expect(hashesMatch(d, { md5: "00" })).toBe(false);
    expect(hashesMatch(d, { dropbox: "x" })).toBeUndefined();
  });
});
