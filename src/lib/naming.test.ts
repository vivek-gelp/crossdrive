import { describe, expect, it } from "vitest";
import { isGoogleNativeMime, validateName } from "./naming";

describe("validateName", () => {
  it("accepts YYYY-MM-DD_Company_WhatItIs.ext", () => {
    expect(validateName("2026-11-09_Acme_BoardDeck.pdf")).toEqual({ ok: true });
    expect(validateName("2024-01-31_Umbrella_Q4-Invoice-Summary.xlsx")).toEqual({ ok: true });
  });
  it("rejects missing date, bad date, missing parts, missing extension", () => {
    expect(validateName("Acme_BoardDeck.pdf").ok).toBe(false);
    expect(validateName("2026-13-09_Acme_BoardDeck.pdf").ok).toBe(false);
    expect(validateName("2026-11-09_BoardDeck.pdf").ok).toBe(false);
    expect(validateName("2026-11-09_Acme_BoardDeck").ok).toBe(false);
    expect(validateName("").ok).toBe(false);
  });
  it("rejects path separators and control chars", () => {
    expect(validateName("2026-11-09_Acme_a/b.pdf").ok).toBe(false);
  });
  it("explains the rule in the error", () => {
    const r = validateName("notes.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/YYYY-MM-DD_Company_WhatItIs\.ext/);
  });
});

describe("isGoogleNativeMime", () => {
  it("exempts Google-native types", () => {
    expect(isGoogleNativeMime("application/vnd.google-apps.document")).toBe(true);
    expect(isGoogleNativeMime("application/vnd.google-apps.folder")).toBe(true);
    expect(isGoogleNativeMime("application/pdf")).toBe(false);
  });
});
