import { afterEach, describe, expect, it, vi } from "vitest";
import { allowedEmails, baseUrl, encKey, env, envName, jwtEnv } from "./config";
import { namingRuleEnabled } from "./naming";
import { configWarnings } from "./status";
import { setupChecks } from "./setup";

afterEach(() => vi.unstubAllEnvs());

describe("env(): CROSSDRIVE_ with VAULT_ fallback", () => {
  it("prefers CROSSDRIVE_, falls back to VAULT_, treats empty as unset", () => {
    const src = { CROSSDRIVE_BASE_URL: "https://new.example.com", VAULT_BASE_URL: "https://old.example.com", VAULT_ENC_KEY: "legacy", CROSSDRIVE_JWT_SECRET: "", VAULT_JWT_SECRET: "old-secret" };
    expect(env("BASE_URL", src)).toBe("https://new.example.com");
    expect(env("ENC_KEY", src)).toBe("legacy");
    expect(env("JWT_SECRET", src)).toBe("old-secret");
    expect(env("ALLOWED_EMAILS", src)).toBeUndefined();
    expect(envName("JWT_SECRET")).toBe("CROSSDRIVE_JWT_SECRET");
  });

  it("drives the config accessors from process.env either way", () => {
    vi.stubEnv("VAULT_BASE_URL", "https://old.example.com/");
    vi.stubEnv("VAULT_ALLOWED_EMAILS", "Old@Example.com");
    expect(baseUrl()).toBe("https://old.example.com");
    expect(allowedEmails()).toEqual(["old@example.com"]);
    vi.stubEnv("CROSSDRIVE_BASE_URL", "https://new.example.com");
    vi.stubEnv("CROSSDRIVE_ALLOWED_EMAILS", "new@example.com");
    expect(baseUrl()).toBe("https://new.example.com");
    expect(allowedEmails()).toEqual(["new@example.com"]);
    vi.stubEnv("CROSSDRIVE_NAMING_RULE", "date-entity");
    expect(namingRuleEnabled()).toBe(true);
  });

  it("names the CROSSDRIVE_ form in errors, warnings and the setup page", () => {
    vi.stubEnv("VAULT_JWT_SECRET", "");
    vi.stubEnv("CROSSDRIVE_JWT_SECRET", "");
    vi.stubEnv("VAULT_ENC_KEY", "");
    expect(() => jwtEnv()).toThrow("CROSSDRIVE_JWT_SECRET is not set");
    expect(() => encKey()).toThrow("CROSSDRIVE_ENC_KEY is not set");
    expect(configWarnings({ GOOGLE_CLIENT_ID: "x", GOOGLE_CLIENT_SECRET: "y", BLOB_READ_WRITE_TOKEN: "b", VAULT_BASE_URL: "https://a.example.com" })[0]).toBe(
      "Missing environment variables: CROSSDRIVE_JWT_SECRET, CROSSDRIVE_ENC_KEY, CROSSDRIVE_ALLOWED_EMAILS.",
    );
    const checks = setupChecks({ env: { CROSSDRIVE_BASE_URL: "https://a.example.com" }, requestOrigin: "https://a.example.com", accounts: 0 });
    expect(checks.find((c) => c.id === "env:VAULT_BASE_URL")).toMatchObject({ title: "CROSSDRIVE_BASE_URL is set", ok: true });
    expect(checks.find((c) => c.id === "base-url")?.ok).toBe(true);
    expect(JSON.stringify(checks)).not.toMatch(/"title":"VAULT_/);
  });
});
