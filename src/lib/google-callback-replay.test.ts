import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/oauth/google-callback/route";
import { ALREADY_ANSWERED } from "./consent";
import { issueState } from "./jwt";
import { registerClient } from "./oauth";
import { setStore } from "./store";

/** Round 2 cosmetic: Back after answering the consent screen re-requests the Google callback with a used code. */

const exchange = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./google", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./google")>();
  return {
    ...orig,
    loginRedirectUri: () => "https://vault.example.com/oauth/google-callback",
    exchangeCode: async () => {
      // Google refuses a second redemption of the same code.
      if (++exchange.calls > 1) throw new Error("Google token exchange failed (400)");
      return { access_token: "a", id_token: "id" };
    },
    verifyGoogleIdToken: async () => ({ email: "alex@example.com", sub: "1" }),
  };
});

const BASE = "https://vault.example.com";
const KEYS = ["VAULT_JWT_SECRET", "VAULT_BASE_URL", "VAULT_ALLOWED_EMAILS"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.VAULT_JWT_SECRET = randomBytes(32).toString("base64");
  process.env.VAULT_BASE_URL = BASE;
  process.env.VAULT_ALLOWED_EMAILS = "alex@example.com";
  setStore(undefined);
  exchange.calls = 0;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("Google callback replay", () => {
  it("the first visit shows the consent screen; the same URL again gets a 409 page, not a redirect to the client", async () => {
    const redirect_uri = "https://claude.ai/api/mcp/auth_callback";
    const { client_id } = await registerClient({ redirect_uris: [redirect_uri], client_name: "Example Client" });
    const env = { secret: process.env.VAULT_JWT_SECRET!, issuer: BASE };
    const state = await issueState(env, { purpose: "oauth", client_id, redirect_uri, code_challenge: "c".repeat(43), state: "st-1" });
    const url = `${BASE}/oauth/google-callback?code=google-code-1&state=${encodeURIComponent(state)}`;

    const first = await GET(new Request(url));
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Approve");

    const again = await GET(new Request(url));
    expect(again.status).toBe(409);
    expect(again.headers.get("location")).toBeNull();
    expect(await again.text()).toContain(ALREADY_ANSWERED);
    expect(exchange.calls).toBe(1); // the used Google code is not sent to Google again
  });
});
