import { randomBytes } from "node:crypto";
import { OAuthError as McpOAuthError } from "@modelcontextprotocol/server";
import { withMcpAuth } from "mcp-handler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileResult } from "./ctx";
import { mimeTypeForName } from "./filetypes";
import { INVALID_BEARER, verifyBearer } from "./oauth";

/** Small defects from the first live acceptance test of 1.0.1. */

describe("owner of items whose owner Drive withholds", () => {
  const own = "alex@example.com";
  it("reports owner unknown and shared=true instead of me", () => {
    const r = fileResult("personal", own, { id: "x", name: "x.pdf", mimeType: "application/pdf", ownedByMe: false }, "personal:~shared/x.pdf");
    expect(r).toMatchObject({ owner: "unknown", shared: true });
  });
  it("reports Shared Drive items as owned by the drive and own items as me", () => {
    expect(fileResult("work", own, { id: "d", name: "d", mimeType: "x", driveId: "d1" }, "work:drive/Finance/d")).toMatchObject({ owner: 'shared drive "Finance"', shared: false });
    expect(fileResult("work", own, { id: "o", name: "o", mimeType: "x", ownedByMe: true }, "")).toMatchObject({ owner: "me", shared: false });
    expect(fileResult("work", own, { id: "o", name: "o", mimeType: "x", owners: [{ emailAddress: "Alex@Example.com" }] }, "")).toMatchObject({ owner: "me", shared: false });
    expect(fileResult("work", own, { id: "s", name: "s", mimeType: "x", owners: [{ emailAddress: "sam@example.org" }], ownedByMe: false }, "")).toMatchObject({
      owner: "sam@example.org",
      shared: true,
    });
  });
});

describe("extension MIME table", () => {
  it("knows the common office and image types, case-insensitively", () => {
    expect(mimeTypeForName("A.PDF")).toBe("application/pdf");
    expect(mimeTypeForName("photo.JPEG")).toBe("image/jpeg");
    expect(mimeTypeForName("noext")).toBeUndefined();
  });
});

describe("bearer errors", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.VAULT_JWT_SECRET;
    process.env.VAULT_JWT_SECRET = randomBytes(32).toString("base64");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.VAULT_JWT_SECRET;
    else process.env.VAULT_JWT_SECRET = saved;
  });

  it("a bad bearer is reported as invalid, a missing one as missing", async () => {
    const req = new Request("https://vault.example.com/api/mcp", { method: "POST" });
    await expect(verifyBearer(req, undefined)).resolves.toBeUndefined();
    const err = await verifyBearer(req, "garbage").catch((e: unknown) => e);
    expect(McpOAuthError.isInstance(err)).toBe(true);
    expect((err as Error).message).toBe(INVALID_BEARER);
  });

  it("mcp-handler answers 401 with the invalid-token text, not 'No authorization provided'", async () => {
    const handler = withMcpAuth(async () => new Response("ok"), verifyBearer, { required: true, resourceUrl: "https://vault.example.com" });
    const bad = await handler(new Request("https://vault.example.com/api/mcp", { method: "POST", headers: { Authorization: "Bearer garbage" } }));
    expect(bad.status).toBe(401);
    const text = `${bad.headers.get("www-authenticate") ?? ""} ${await bad.text()}`;
    expect(text).toContain("Invalid or expired access token");
    expect(text).not.toContain("No authorization provided");
    const none = await handler(new Request("https://vault.example.com/api/mcp", { method: "POST" }));
    expect(none.status).toBe(401);
    expect(`${none.headers.get("www-authenticate") ?? ""} ${await none.text()}`).toContain("No authorization provided");
  });
});
