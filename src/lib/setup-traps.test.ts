import { afterEach, describe, expect, it, vi } from "vitest";
import {
  baseUrl,
  googleClientIdProblem,
  googleClientProblem,
  googleClientSecretHasPrefix,
  googleClientSecretProblem,
  resolveBaseUrl,
} from "./config";
import { googleConfigError } from "./http";
import { setupChecks } from "./setup";
import { baseUrlMismatch, configWarnings } from "./status";

afterEach(() => vi.unstubAllEnvs());

const SECRET = Buffer.alloc(32, 5).toString("base64");
const ID = "123-abc.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-abcdef";

describe("base URL fallback order", () => {
  it("prefers CROSSDRIVE_BASE_URL, then VAULT_BASE_URL, then Vercel's production host, then localhost", () => {
    const vercel = { VERCEL_PROJECT_PRODUCTION_URL: "my-drive.vercel.app" };
    expect(resolveBaseUrl({ ...vercel, CROSSDRIVE_BASE_URL: "https://files.example.com/", VAULT_BASE_URL: "https://old.example.com" })).toEqual({
      url: "https://files.example.com",
      source: "env",
    });
    expect(resolveBaseUrl({ ...vercel, VAULT_BASE_URL: "https://old.example.com" })).toEqual({ url: "https://old.example.com", source: "env" });
    expect(resolveBaseUrl(vercel)).toEqual({ url: "https://my-drive.vercel.app", source: "vercel" });
    expect(resolveBaseUrl({ ...vercel, CROSSDRIVE_BASE_URL: "" })).toEqual({ url: "https://my-drive.vercel.app", source: "vercel" });
    expect(resolveBaseUrl({})).toEqual({ url: "http://localhost:3000", source: "default" });
  });

  it("does not double the scheme and drives baseUrl() from process.env", () => {
    expect(resolveBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "https://my-drive.vercel.app/" }).url).toBe("https://my-drive.vercel.app");
    vi.stubEnv("CROSSDRIVE_BASE_URL", "");
    vi.stubEnv("VAULT_BASE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "my-drive.vercel.app");
    expect(baseUrl()).toBe("https://my-drive.vercel.app");
    vi.stubEnv("CROSSDRIVE_BASE_URL", "https://files.example.com");
    expect(baseUrl()).toBe("https://files.example.com");
  });
});

describe("base URL in /setup and warnings", () => {
  const rest = {
    CROSSDRIVE_JWT_SECRET: SECRET,
    CROSSDRIVE_ENC_KEY: SECRET,
    CROSSDRIVE_ALLOWED_EMAILS: "alex@example.com",
    GOOGLE_CLIENT_ID: ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    BLOB_READ_WRITE_TOKEN: "blob",
  };

  it("passes with a note when the value comes from Vercel", () => {
    const env = { ...rest, VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "my-drive.vercel.app" };
    const checks = setupChecks({ env, requestOrigin: "https://my-drive.vercel.app", accounts: 1 });
    expect(checks.filter((c) => c.ok === false)).toEqual([]);
    expect(checks.find((c) => c.id === "env:VAULT_BASE_URL")).toMatchObject({ ok: true, title: expect.stringMatching(/taken from Vercel \(set CROSSDRIVE_BASE_URL to use a custom domain\)/) });
    expect(checks.find((c) => c.id === "base-url")).toMatchObject({ ok: true, detail: expect.stringMatching(/taken from Vercel/) });
    expect(configWarnings(env)).toEqual([]);
  });

  it("asks for a look (not a failure) when the page is opened on a preview address", () => {
    const checks = setupChecks({ env: { ...rest, VERCEL_PROJECT_PRODUCTION_URL: "my-drive.vercel.app" }, requestOrigin: "https://my-drive-git-x.vercel.app", accounts: 1 });
    expect(checks.find((c) => c.id === "base-url")?.ok).toBeNull();
  });

  it("still fails when nothing provides a base URL", () => {
    const checks = setupChecks({ env: rest, requestOrigin: "http://localhost:3000", accounts: 1 });
    expect(checks.find((c) => c.id === "env:VAULT_BASE_URL")?.ok).toBe(false);
    expect(checks.find((c) => c.id === "base-url")?.ok).toBe(false);
    expect(configWarnings(rest)[0]).toBe("Missing environment variables: CROSSDRIVE_BASE_URL.");
  });

  it("explains a wrong explicit value, e.g. the GitHub repository link", () => {
    const msg = baseUrlMismatch("https://github.com/someone/crossdrive", "https://my-drive.vercel.app");
    expect(msg).toContain('"https://github.com/someone/crossdrive"');
    expect(msg).toMatch(/differs/);
    expect(msg).toMatch(/must be this deployment's own address \(such as https:\/\/my-drive\.vercel\.app\), not the GitHub repository URL/);
    const env = { ...rest, CROSSDRIVE_BASE_URL: "https://github.com/someone/crossdrive", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "my-drive.vercel.app" };
    expect(configWarnings(env).join(" ")).toMatch(/GitHub repository URL/);
    expect(setupChecks({ env, requestOrigin: "https://my-drive.vercel.app", accounts: 1 }).find((c) => c.id === "base-url")?.ok).toBe(false);
  });
});

describe("Google client shape checks", () => {
  it("accepts a real-looking client ID and rejects placeholders and other text", () => {
    expect(googleClientIdProblem(ID)).toBeNull();
    expect(googleClientIdProblem(undefined)).toBeNull();
    for (const bad of ["PASTE_CLIENT_ID", "YOUR_CLIENT_ID.apps.googleusercontent.com", ".apps.googleusercontent.com", "123 .apps.googleusercontent.com", "https://github.com/x/y"]) {
      expect(googleClientIdProblem(bad), bad).toMatch(/does not look like a Google client ID.*Google Auth Platform → Clients/);
    }
  });

  it("rejects empty, whitespace and placeholder secrets; a missing GOCSPX- prefix is not an error", () => {
    expect(googleClientSecretProblem(CLIENT_SECRET)).toBeNull();
    expect(googleClientSecretProblem("old-style-secret")).toBeNull();
    expect(googleClientSecretProblem("")).toMatch(/empty/);
    expect(googleClientSecretProblem("GOCSPX-abc def")).toMatch(/spaces/);
    expect(googleClientSecretProblem("GOCSPX-abc\n")).toMatch(/spaces/);
    for (const bad of ["PASTE_CLIENT_SECRET", "your_secret", "ChangeMe", "<secret>", "GOCSPX-xxxxxx"]) {
      expect(googleClientSecretProblem(bad), bad).toMatch(/placeholder/);
    }
    expect(googleClientSecretHasPrefix(CLIENT_SECRET)).toBe(true);
    expect(googleClientSecretHasPrefix("old-style-secret")).toBe(false);
  });

  it("fails the /setup rows for placeholders without printing the values", () => {
    const env = { CROSSDRIVE_BASE_URL: "https://a.example.com", GOOGLE_CLIENT_ID: "PASTE_CLIENT_ID", GOOGLE_CLIENT_SECRET: "PASTE_CLIENT_SECRET" };
    const checks = setupChecks({ env, requestOrigin: "https://a.example.com", accounts: 0 });
    expect(checks.find((c) => c.id === "env:GOOGLE_CLIENT_ID")).toMatchObject({ ok: false, detail: expect.stringMatching(/does not look like a Google client ID/) });
    expect(checks.find((c) => c.id === "env:GOOGLE_CLIENT_SECRET")).toMatchObject({ ok: false, detail: expect.stringMatching(/placeholder/) });
    expect(checks.find((c) => c.id === "google")?.ok).toBe(false);
    expect(JSON.stringify(checks)).not.toContain("PASTE_CLIENT");
    expect(configWarnings(env).join(" ")).not.toContain("PASTE_CLIENT");
  });

  it("marks a secret without the GOCSPX- prefix as 'check', not fail", () => {
    const env = { CROSSDRIVE_BASE_URL: "https://a.example.com", GOOGLE_CLIENT_ID: ID, GOOGLE_CLIENT_SECRET: "old-style-secret" };
    const checks = setupChecks({ env, requestOrigin: "https://a.example.com", accounts: 0 });
    expect(checks.find((c) => c.id === "env:GOOGLE_CLIENT_SECRET")).toMatchObject({ ok: null, detail: expect.stringMatching(/GOCSPX-/) });
    expect(checks.find((c) => c.id === "google")?.ok).toBe(true);
  });

  it("googleClientProblem and the error page point to /setup instead of sending users to Google", async () => {
    expect(googleClientProblem({ GOOGLE_CLIENT_ID: ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET })).toBeNull();
    expect(googleClientProblem({})).toMatch(/not configured.*\/setup/);
    expect(googleClientProblem({ GOOGLE_CLIENT_ID: "PASTE_CLIENT_ID", GOOGLE_CLIENT_SECRET: CLIENT_SECRET })).toMatch(/^The Google OAuth client is misconfigured\. GOOGLE_CLIENT_ID: .*\/setup/);

    vi.stubEnv("GOOGLE_CLIENT_ID", "PASTE_CLIENT_ID");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", CLIENT_SECRET);
    const res = googleConfigError();
    expect(res?.status).toBe(503);
    const html = await res!.text();
    expect(html).toContain('href="/setup"');
    expect(html).not.toContain("PASTE_CLIENT_ID");
    vi.stubEnv("GOOGLE_CLIENT_ID", ID);
    expect(googleConfigError()).toBeNull();
  });
});
