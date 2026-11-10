import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptJson } from "./crypto";
import { DRIVE_SCOPE, GMAIL_SCOPES, googleConsentUrl, parseGrantedScopes } from "./google";
import { accountScopes, gmailGranted, loadAccounts, setStore, type Account } from "./store";
import { memoryStore } from "./testing/fakeDrive";

const KEY = Buffer.alloc(32, 7).toString("base64");

describe("parseGrantedScopes", () => {
  it("keeps drive and gmail scopes as short names, sorted, and drops identity scopes", () => {
    const s = parseGrantedScopes(
      "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.modify",
    );
    expect(s).toEqual(["drive", "gmail.modify", "gmail.send"]);
  });
  it("falls back to drive alone when Google sends no scope field", () => {
    expect(parseGrantedScopes(undefined)).toEqual(["drive"]);
    expect(parseGrantedScopes("")).toEqual(["drive"]);
  });
});

describe("gmailGranted / accountScopes", () => {
  const base: Account = { label: "work", email: "v@x.com", refresh_token: "r", connectedAt: "2026-01-01T00:00:00Z" };
  it("treats a record without scopes as drive-only", () => {
    expect(accountScopes(base)).toEqual(["drive"]);
    expect(gmailGranted(base)).toBe(false);
  });
  it("needs all three gmail scopes", () => {
    expect(gmailGranted({ ...base, scopes: ["drive", "gmail.modify"] })).toBe(false);
    expect(gmailGranted({ ...base, scopes: ["drive", "gmail.modify", "gmail.compose", "gmail.send"] })).toBe(true);
  });
});

describe("loadAccounts migration", () => {
  beforeEach(() => {
    process.env.VAULT_ENC_KEY = KEY;
  });
  afterEach(() => {
    setStore(undefined);
    delete process.env.VAULT_ENC_KEY;
  });
  it("adds scopes=[drive] to stored records that predate scopes", async () => {
    const store = memoryStore();
    await store.write(
      "accounts.enc",
      encryptJson(
        [
          { label: "work", email: "v@x.com", refresh_token: "r", connectedAt: "2026-01-01T00:00:00Z" },
          { label: "family", email: "m@x.com", refresh_token: "r", connectedAt: "2026-01-01T00:00:00Z", scopes: ["drive", "gmail.modify", "gmail.compose", "gmail.send"] },
        ],
        KEY,
      ),
    );
    setStore(store);
    const accounts = await loadAccounts(true);
    expect(accounts.map((a) => a.scopes)).toEqual([["drive"], ["drive", "gmail.modify", "gmail.compose", "gmail.send"]]);
  });
});

describe("googleConsentUrl", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
  });
  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  it("asks for Drive and the three Gmail scopes with incremental auth and forced consent", () => {
    const u = new URL(googleConsentUrl("st"));
    const scope = (u.searchParams.get("scope") ?? "").split(" ");
    expect(scope).toContain(DRIVE_SCOPE);
    for (const s of GMAIL_SCOPES) expect(scope).toContain(s);
    expect(u.searchParams.get("include_granted_scopes")).toBe("true");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.has("login_hint")).toBe(false);
  });
  it("adds login_hint when re-running consent for a known account", () => {
    const u = new URL(googleConsentUrl("st", { loginHint: "alex@acme.example" }));
    expect(u.searchParams.get("login_hint")).toBe("alex@acme.example");
  });
});
