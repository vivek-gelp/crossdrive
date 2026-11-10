import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideConsent, escapeHtml, issuePendingConsent, renderConsentPage, type PendingConsent } from "./consent";
import { issueConsent, issueState } from "./jwt";
import {
  authorizationServerMetadata,
  describeRedirect,
  handleTokenRequest,
  OAuthError,
  protectedResourceMetadata,
  registerClient,
  SCOPE_FULL,
  SCOPE_READ,
  validateAuthorizeRequest,
  validateRedirectUri,
} from "./oauth";

const BASE = "https://vault.example.com";
let saved: { secret?: string; base?: string };

beforeEach(() => {
  saved = { secret: process.env.VAULT_JWT_SECRET, base: process.env.VAULT_BASE_URL };
  process.env.VAULT_JWT_SECRET = randomBytes(32).toString("base64");
  process.env.VAULT_BASE_URL = BASE;
});
afterEach(() => {
  if (saved.secret === undefined) delete process.env.VAULT_JWT_SECRET;
  else process.env.VAULT_JWT_SECRET = saved.secret;
  if (saved.base === undefined) delete process.env.VAULT_BASE_URL;
  else process.env.VAULT_BASE_URL = saved.base;
});

const verifier = "v".repeat(50);
const challenge = createHash("sha256").update(verifier).digest("base64url");

function pending(extra: Partial<PendingConsent> = {}): PendingConsent {
  return {
    client_id: "cid",
    client_name: "Example Client",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: challenge,
    state: "st-1",
    scope: SCOPE_FULL,
    email: "alex@example.com",
    ...extra,
  };
}

async function decide(p: PendingConsent, fields: Record<string, string>) {
  const consent = await issuePendingConsent(p);
  return new URL(await decideConsent(new URLSearchParams({ consent, ...fields })));
}

describe("consent page", () => {
  it("escapes the attacker-supplied client name and shows the redirect host as the trusted fact", () => {
    const html = renderConsentPage(pending({ client_name: `<script>alert(1)</script>"x` }), "tok");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&quot;x");
    expect(html).toContain("name not verified");
    expect(html).toMatch(/class="redirect-host">claude\.ai</);
    expect(html).toContain('value="full" checked');
  });
  it("offers only read-only when the client asked for read-only", () => {
    const html = renderConsentPage(pending({ scope: SCOPE_READ }), "tok");
    expect(html).not.toContain('value="full"');
    expect(html).toContain('value="read" checked');
  });
  it("describes loopback and native redirects", () => {
    expect(describeRedirect("http://127.0.0.1:33418/cb")).toEqual({ host: "127.0.0.1:33418", kind: "loopback" });
    expect(describeRedirect("cursor://anysphere.cursor-retrieval/oauth")).toEqual({ host: "cursor://anysphere.cursor-retrieval", kind: "native" });
    expect(escapeHtml(`a&'b`)).toBe("a&amp;&#39;b");
  });
});

describe("decideConsent", () => {
  it("approve issues a code that redeems with PKCE and keeps the state", async () => {
    const u = await decide(pending(), { decision: "approve", access: "full" });
    expect(u.origin + u.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(u.searchParams.get("state")).toBe("st-1");
    const tok = await handleTokenRequest(
      new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code") ?? "", code_verifier: verifier, client_id: "cid" }),
    );
    expect(tok.scope).toBe(SCOPE_FULL);
    const refreshed = await handleTokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }));
    expect(refreshed.scope).toBe(SCOPE_FULL);
  });
  it("the approver can downgrade to read-only, and the downgrade survives refresh", async () => {
    const u = await decide(pending(), { decision: "approve", access: "read" });
    const tok = await handleTokenRequest(
      new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code") ?? "", code_verifier: verifier }),
    );
    expect(tok.scope).toBe(SCOPE_READ);
    const refreshed = await handleTokenRequest(new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }));
    expect(refreshed.scope).toBe(SCOPE_READ);
  });
  it("cannot upgrade a read-only request to full", async () => {
    const u = await decide(pending({ scope: SCOPE_READ }), { decision: "approve", access: "full" });
    const tok = await handleTokenRequest(
      new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code") ?? "", code_verifier: verifier }),
    );
    expect(tok.scope).toBe(SCOPE_READ);
  });
  it("deny returns access_denied without a code", async () => {
    const u = await decide(pending(), { decision: "deny" });
    expect(u.searchParams.get("error")).toBe("access_denied");
    expect(u.searchParams.get("code")).toBeNull();
    expect(u.searchParams.get("state")).toBe("st-1");
  });
  it("rejects forged, expired or other-kind tokens", async () => {
    await expect(decideConsent(new URLSearchParams({ consent: "x", decision: "approve" }))).rejects.toBeInstanceOf(OAuthError);
    const env = { secret: process.env.VAULT_JWT_SECRET ?? "", issuer: BASE };
    const old = await issueConsent(env, pending(), { now: Math.floor(Date.now() / 1000) - 3600 });
    await expect(decideConsent(new URLSearchParams({ consent: old, decision: "approve", access: "full" }))).rejects.toThrow(/expired/);
    const state = await issueState(env, { purpose: "admin" });
    await expect(decideConsent(new URLSearchParams({ consent: state, decision: "approve", access: "full" }))).rejects.toThrow();
  });
});

describe("authorize scope handling", () => {
  async function params(scope?: string) {
    const reg = await registerClient({ redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], client_name: "ChatGPT" });
    const p = new URLSearchParams({
      client_id: reg.client_id,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    if (scope !== undefined) p.set("scope", scope);
    return p;
  }
  it("defaults to full, accepts vault:read, rejects unknown scopes", async () => {
    expect((await validateAuthorizeRequest(await params())).scope).toBe(SCOPE_FULL);
    expect((await validateAuthorizeRequest(await params(""))).scope).toBe(SCOPE_FULL);
    expect((await validateAuthorizeRequest(await params("vault:read"))).scope).toBe(SCOPE_READ);
    expect((await validateAuthorizeRequest(await params("vault vault:read"))).scope).toBe(SCOPE_FULL);
    await expect(validateAuthorizeRequest(await params("admin"))).rejects.toThrow(/invalid_scope/);
  });
});

describe("dynamic client registration hardening", () => {
  it("accepts https, loopback http and native-app schemes", () => {
    for (const u of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "http://localhost:6274/oauth/callback",
      "http://127.0.0.1:33418/",
      "cursor://anysphere.cursor-retrieval/oauth/user-vault/callback",
      "com.example.app:/oauth2redirect",
    ]) {
      expect(validateRedirectUri(u), u).toBe(true);
    }
  });
  it("rejects dangerous or ambiguous redirect URIs", () => {
    for (const u of [
      "http://example.com/cb",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "https://a.example/cb#frag",
      "https://user:pw@a.example/cb",
      `https://a.example/${"x".repeat(2100)}`,
      "not a uri",
    ]) {
      expect(validateRedirectUri(u), u).toBe(false);
    }
  });
  it("caps the number of redirect URIs and the client name length, stripping control characters", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `https://a.example/cb${i}`);
    await expect(registerClient({ redirect_uris: many })).rejects.toThrow(/invalid_redirect_uri/);
    const r = await registerClient({ redirect_uris: ["https://a.example/cb"], client_name: `Bad\u0000Name${"n".repeat(300)}` });
    expect(r.client_name?.startsWith("BadName")).toBe(true);
    expect(r.client_name?.length).toBe(200);
  });
  it("leaves the well-known metadata shape unchanged", () => {
    expect(Object.keys(authorizationServerMetadata()).sort()).toEqual(
      [
        "issuer",
        "authorization_endpoint",
        "token_endpoint",
        "registration_endpoint",
        "scopes_supported",
        "response_types_supported",
        "response_modes_supported",
        "grant_types_supported",
        "token_endpoint_auth_methods_supported",
        "code_challenge_methods_supported",
        "service_documentation",
      ].sort(),
    );
    expect(authorizationServerMetadata().code_challenge_methods_supported).toEqual(["S256"]);
    expect(protectedResourceMetadata().resource).toBe(`${BASE}/api/mcp`);
  });
});
