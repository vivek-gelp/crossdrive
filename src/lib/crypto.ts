import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM: base64( iv(12) | tag(16) | ciphertext ). */

function loadKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("CROSSDRIVE_ENC_KEY must decode to exactly 32 bytes");
  return key;
}

export function encryptJson(value: unknown, keyB64: string): string {
  const key = loadKey(keyB64);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptJson<T = unknown>(blobB64: string, keyB64: string): T {
  const key = loadKey(keyB64);
  const buf = Buffer.from(blobB64, "base64");
  if (buf.length < 28) throw new Error("ciphertext too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
