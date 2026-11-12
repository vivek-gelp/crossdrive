import { describe, expect, it } from "vitest";
import { checkCsrf, cookieValue, csrfToken, originAllowed } from "./csrf";
import { googleRedirectUris, setupChecks } from "./setup";

const SECRET = Buffer.alloc(32, 5).toString("base64");

describe("csrf", () => {
  const ok = { origin: "https://vault.example.com", allowedOrigins: ["https://vault.example.com"], sessionToken: "sess", secret: SECRET };
  it("accepts the token derived from the session", () => {
    expect(checkCsrf({ ...ok, formToken: csrfToken("sess", SECRET) })).toBeNull();
    expect(checkCsrf({ ...ok, origin: null, formToken: csrfToken("sess", SECRET) })).toBeNull();
  });
  it("rejects foreign origins, missing sessions and wrong tokens", () => {
    const t = csrfToken("sess", SECRET);
    expect(checkCsrf({ ...ok, origin: "https://evil.example", formToken: t })).toMatch(/Origin/);
    expect(checkCsrf({ ...ok, origin: "null", formToken: t })).toMatch(/Origin/);
    expect(checkCsrf({ ...ok, sessionToken: undefined, formToken: t })).toMatch(/session/);
    expect(checkCsrf({ ...ok, formToken: csrfToken("other-session", SECRET) })).toMatch(/token/);
    expect(checkCsrf({ ...ok, formToken: null })).toMatch(/token/);
  });
  it("originAllowed compares origins, ignoring paths", () => {
    expect(originAllowed("https://vault.example.com", ["https://vault.example.com/"])).toBe(true);
    expect(originAllowed("https://vault.example.com.evil.example", ["https://vault.example.com"])).toBe(false);
  });
  it("cookieValue parses a Cookie header", () => {
    expect(cookieValue("a=1; vault_admin=abc.def; b=2", "vault_admin")).toBe("abc.def");
    expect(cookieValue(null, "vault_admin")).toBeUndefined();
  });
});

describe("setupChecks", () => {
  const full = {
    VAULT_BASE_URL: "https://vault.example.com",
    VAULT_JWT_SECRET: SECRET,
    VAULT_ENC_KEY: SECRET,
    VAULT_ALLOWED_EMAILS: "alex@example.com",
    GOOGLE_CLIENT_ID: "cid-value.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "GOCSPX-secret-value",
    BLOB_READ_WRITE_TOKEN: "blob-value",
  };
  it("passes a complete setup; optional vars and manual reminders are neither pass nor fail", () => {
    const checks = setupChecks({ env: full, requestOrigin: "https://vault.example.com", accounts: 2 });
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    expect(checks.find((c) => c.id === "publish")?.ok).toBeNull();
    expect(checks.find((c) => c.id === "env:VAULT_STATIC_TOKENS")?.ok).toBeNull();
    expect(JSON.stringify(checks)).not.toMatch(/cid-value|secret-value|blob-value|alex@example\.com/);
  });
  it("fails missing env, short keys, base URL mismatch and no accounts", () => {
    const checks = setupChecks({
      env: { ...full, GOOGLE_CLIENT_SECRET: undefined, VAULT_ENC_KEY: Buffer.alloc(16).toString("base64") },
      requestOrigin: "https://other.example.org",
      accounts: 0,
    });
    const failed = checks.filter((c) => c.ok === false).map((c) => c.id);
    expect(failed).toEqual(["env:GOOGLE_CLIENT_SECRET", "enc-length", "google", "base-url", "accounts"]);
  });
  it("derives both Google redirect URIs from the base URL", () => {
    expect(googleRedirectUris("https://vault.example.com/")).toEqual([
      "https://vault.example.com/oauth/google-callback",
      "https://vault.example.com/api/google/callback",
    ]);
  });
});
