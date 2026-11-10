/**
 * Streaming implementations of the content hashes the providers report, so a
 * transfer can hash the bytes as they pass through and compare with what the
 * source and the destination say.
 *
 * - QuickXorHash (OneDrive): every byte n is XORed into a 160-bit register at
 *   bit offset (11·n) mod 160, rotating across the top; the little-endian
 *   register then gets the 64-bit length XORed into its last 8 bytes. Because
 *   11 and 160 are coprime, the offset depends only on n mod 160, so bytes
 *   are folded into 160 accumulators first and placed once at the end.
 * - Dropbox content_hash: SHA-256 of the concatenated SHA-256 digests of
 *   every 4 MiB block, hex.
 */
import { createHash, type Hash } from "node:crypto";
import type { HashKind, Hashes } from "./types";

const WIDTH = 160;
const SHIFT = 11;
const MASK160 = (1n << 160n) - 1n;

export class QuickXorHash {
  private readonly acc = new Uint8Array(WIDTH);
  private length = 0;

  update(data: Uint8Array): this {
    const acc = this.acc;
    let slot = this.length % WIDTH;
    for (let i = 0; i < data.length; i++) {
      acc[slot] = acc[slot]! ^ data[i]!;
      slot = slot === WIDTH - 1 ? 0 : slot + 1;
    }
    this.length += data.length;
    return this;
  }

  digest(): Uint8Array {
    let reg = 0n;
    for (let s = 0; s < WIDTH; s++) {
      const b = this.acc[s]!;
      if (!b) continue;
      const v = BigInt(b) << BigInt((SHIFT * s) % WIDTH);
      reg ^= (v & MASK160) | (v >> 160n);
    }
    const out = new Uint8Array(20);
    for (let i = 0; i < 20; i++) out[i] = Number((reg >> BigInt(8 * i)) & 0xffn);
    let len = BigInt(this.length);
    for (let i = 0; i < 8; i++) {
      out[12 + i] = out[12 + i]! ^ Number(len & 0xffn);
      len >>= 8n;
    }
    return out;
  }

  digestBase64(): string {
    return Buffer.from(this.digest()).toString("base64");
  }
}

export const DROPBOX_BLOCK = 4 * 1024 * 1024;

export class DropboxContentHash {
  private readonly overall = createHash("sha256");
  private block = createHash("sha256");
  private inBlock = 0;

  update(data: Uint8Array): this {
    let pos = 0;
    while (pos < data.length) {
      const take = Math.min(DROPBOX_BLOCK - this.inBlock, data.length - pos);
      this.block.update(data.subarray(pos, pos + take));
      this.inBlock += take;
      pos += take;
      if (this.inBlock === DROPBOX_BLOCK) {
        this.overall.update(this.block.digest());
        this.block = createHash("sha256");
        this.inBlock = 0;
      }
    }
    return this;
  }

  digestHex(): string {
    if (this.inBlock > 0) this.overall.update(this.block.digest());
    return this.overall.digest("hex");
  }
}

/** Hashes several kinds over one pass of the bytes. */
export class MultiHasher {
  private readonly qx?: QuickXorHash;
  private readonly dbx?: DropboxContentHash;
  private readonly plain = new Map<HashKind, Hash>();

  constructor(kinds: Iterable<HashKind>) {
    for (const k of new Set(kinds)) {
      if (k === "quickXor") this.qx = new QuickXorHash();
      else if (k === "dropbox") this.dbx = new DropboxContentHash();
      else this.plain.set(k, createHash(k));
    }
  }

  update(data: Uint8Array): void {
    this.qx?.update(data);
    this.dbx?.update(data);
    for (const h of this.plain.values()) h.update(data);
  }

  digest(): Hashes {
    const out: Hashes = {};
    if (this.qx) out.quickXor = this.qx.digestBase64();
    if (this.dbx) out.dropbox = this.dbx.digestHex();
    for (const [k, h] of this.plain) out[k] = h.digest("hex");
    return out;
  }
}

/** Normalise for comparison: hex hashes lower-case, base64 untouched. */
export function normHash(kind: HashKind, v: string): string {
  return kind === "quickXor" ? v.trim() : v.trim().toLowerCase();
}

/** Kinds both sides report a value for. */
export function commonKinds(a: Hashes | undefined, b: Hashes | undefined): HashKind[] {
  if (!a || !b) return [];
  return (Object.keys(a) as HashKind[]).filter((k) => a[k] && b[k]);
}

/** undefined when nothing is comparable, true when every comparable kind matches. */
export function hashesMatch(a: Hashes | undefined, b: Hashes | undefined): boolean | undefined {
  const kinds = commonKinds(a, b);
  if (kinds.length === 0) return undefined;
  return kinds.every((k) => normHash(k, a![k]!) === normHash(k, b![k]!));
}
