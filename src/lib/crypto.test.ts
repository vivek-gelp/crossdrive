import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptJson, encryptJson } from "./crypto";

const key = randomBytes(32).toString("base64");

describe("AES-256-GCM roundtrip", () => {
  it("roundtrips JSON", () => {
    const payload = { accounts: [{ label: "work", email: "a@b.c", refresh_token: "r" }] };
    const blob = encryptJson(payload, key);
    expect(blob).not.toContain("refresh_token");
    expect(decryptJson(blob, key)).toEqual(payload);
  });
  it("produces different ciphertext each time (random IV)", () => {
    expect(encryptJson({ a: 1 }, key)).not.toEqual(encryptJson({ a: 1 }, key));
  });
  it("fails on wrong key or tampering", () => {
    const blob = encryptJson({ a: 1 }, key);
    expect(() => decryptJson(blob, randomBytes(32).toString("base64"))).toThrow();
    const tampered = Buffer.from(blob, "base64");
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    expect(() => decryptJson(tampered.toString("base64"), key)).toThrow();
  });
  it("rejects keys that are not 32 bytes", () => {
    expect(() => encryptJson({ a: 1 }, randomBytes(16).toString("base64"))).toThrow(/32/);
  });
});
