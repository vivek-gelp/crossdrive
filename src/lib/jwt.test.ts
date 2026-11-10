import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  issueAccessToken,
  issueAuthCode,
  issueClientId,
  issueRefreshToken,
  verifyAccessToken,
  verifyAuthCode,
  verifyClientId,
  verifyPkce,
  verifyRefreshToken,
} from "./jwt";

const secret = randomBytes(32).toString("base64");
const issuer = "https://vault.example";
const env = { secret, issuer };

function s256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("client_id JWT", () => {
  it("issues and verifies redirect_uris + client_name", async () => {
    const id = await issueClientId(env, { redirect_uris: ["https://c/cb"], client_name: "Claude" });
    const client = await verifyClientId(env, id);
    expect(client.redirect_uris).toEqual(["https://c/cb"]);
    expect(client.client_name).toBe("Claude");
  });
  it("rejects tokens signed with another secret", async () => {
    const id = await issueClientId({ secret: randomBytes(32).toString("base64"), issuer }, { redirect_uris: ["https://c/cb"] });
    await expect(verifyClientId(env, id)).rejects.toThrow();
  });
});

describe("auth code JWT", () => {
  it("binds code_challenge, client_id, redirect_uri, email; 5 minute expiry", async () => {
    const code = await issueAuthCode(env, {
      client_id: "cid",
      redirect_uri: "https://c/cb",
      code_challenge: "abc",
      email: "v@x.y",
    });
    const claims = await verifyAuthCode(env, code);
    expect(claims.client_id).toBe("cid");
    expect(claims.code_challenge).toBe("abc");
    expect(claims.exp - claims.iat).toBe(300);
  });
  it("rejects an access token presented as an auth code", async () => {
    const at = await issueAccessToken(env, { email: "v@x.y", client_id: "cid", scope: "vault" });
    await expect(verifyAuthCode(env, at)).rejects.toThrow();
  });
  it("rejects expired codes", async () => {
    const code = await issueAuthCode(
      env,
      { client_id: "cid", redirect_uri: "https://c/cb", code_challenge: "abc", email: "v@x.y" },
      { now: Math.floor(Date.now() / 1000) - 600 },
    );
    await expect(verifyAuthCode(env, code)).rejects.toThrow();
  });
});

describe("PKCE S256", () => {
  it("accepts matching verifier", () => {
    const verifier = randomBytes(32).toString("base64url");
    expect(verifyPkce(verifier, s256(verifier))).toBe(true);
  });
  it("rejects mismatch and plain method", () => {
    const verifier = randomBytes(32).toString("base64url");
    expect(verifyPkce(verifier + "x", s256(verifier))).toBe(false);
    expect(verifyPkce(verifier, verifier)).toBe(false);
  });
  it("rejects verifiers outside RFC 7636 length (43-128)", () => {
    expect(verifyPkce("short", s256("short"))).toBe(false);
  });
});

describe("access and refresh tokens", () => {
  it("access token lasts 24h with scope and is distinguished from refresh", async () => {
    const at = await issueAccessToken(env, { email: "v@x.y", client_id: "cid", scope: "vault" });
    const c = await verifyAccessToken(env, at);
    expect(c.email).toBe("v@x.y");
    expect(c.scope).toBe("vault");
    expect(c.exp - c.iat).toBe(24 * 3600);
    await expect(verifyRefreshToken(env, at)).rejects.toThrow();
  });
  it("refresh token lasts 90d", async () => {
    const rt = await issueRefreshToken(env, { email: "v@x.y", client_id: "cid", scope: "vault" });
    const c = await verifyRefreshToken(env, rt);
    expect(c.exp - c.iat).toBe(90 * 24 * 3600);
    await expect(verifyAccessToken(env, rt)).rejects.toThrow();
  });
  it("rejects wrong issuer", async () => {
    const at = await issueAccessToken({ secret, issuer: "https://other" }, { email: "v@x.y", client_id: "cid", scope: "vault" });
    await expect(verifyAccessToken(env, at)).rejects.toThrow();
  });
});
