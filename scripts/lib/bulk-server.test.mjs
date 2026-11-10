import { describe, expect, it } from "vitest";
import { envValue, parseArgs, resolveServerUrl, USAGE } from "./bulk.mjs";

describe("bulk-upload server URL and token", () => {
  it("has no default URL: --url, then CROSSDRIVE_URL, then legacy VAULT_URL", () => {
    expect(USAGE).not.toMatch(/vercel\.app/);
    expect(() => resolveServerUrl({}, {})).toThrow(/pass --url or set CROSSDRIVE_URL/);
    expect(resolveServerUrl({}, { VAULT_URL: "https://old.example.com/" })).toBe("https://old.example.com");
    expect(resolveServerUrl({}, { CROSSDRIVE_URL: "https://new.example.com", VAULT_URL: "https://old.example.com" })).toBe("https://new.example.com");
    const args = parseArgs(["--src", "a", "--dest", "work:/X", "--url", "https://flag.example.com"]);
    expect(resolveServerUrl(args, { CROSSDRIVE_URL: "https://new.example.com" })).toBe("https://flag.example.com");
    expect(resolveServerUrl({ url: "http://localhost:3000" }, {})).toBe("http://localhost:3000");
    expect(() => resolveServerUrl({ url: "http://plain.example.com" }, {})).toThrow(/https/);
  });

  it("reads the token as CROSSDRIVE_TOKEN with the VAULT_TOKEN fallback", () => {
    expect(envValue("TOKEN", { VAULT_TOKEN: "old" })).toBe("old");
    expect(envValue("TOKEN", { CROSSDRIVE_TOKEN: "new", VAULT_TOKEN: "old" })).toBe("new");
    expect(envValue("TOKEN", { CROSSDRIVE_TOKEN: "" })).toBeUndefined();
  });
});
