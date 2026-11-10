/**
 * Store mock for the provider tests (kept free of other imports so vi.mock
 * factories can load it without pulling in modules that import the store).
 */
import type { Account } from "../../store";

export const ACCOUNTS: Account[] = [
  { label: "personal", email: "alex@example.com", provider: "google" },
  { label: "backup", email: "backup@example.com", provider: "google" },
  { label: "work", email: "work@example.com", provider: "microsoft" },
  { label: "archive", email: "archive@example.com", provider: "microsoft", mode: "read" },
  { label: "client-a", email: "client-a@example.com", provider: "dropbox" },
  { label: "client-b", email: "client-b@example.com", provider: "dropbox" },
].map((a) => ({ ...a, label: a.label as Account["label"], refresh_token: `rt-${a.label}`, connectedAt: "2026-01-01T00:00:00Z", scopes: ["drive"] }) as Account);

/** Records upsertAccount calls (token rotation, connect callbacks). */
export const upserts: Account[] = [];

/** For vi.mock("../store"): accounts with providers and modes; Google tokens are `tok-<label>`. */
export function providerStoreMock() {
  const accounts = ACCOUNTS;
  return {
    accessTokenFor: async (a: Account) => `tok-${a.label}`,
    getAccount: async (label: string) => {
      const a = accounts.find((x) => x.label === label);
      if (!a) throw new Error(`No connected account labelled "${label}"`);
      return a;
    },
    loadAccounts: async () => accounts,
    upsertAccount: async (a: Account) => {
      upserts.push(a);
      return accounts;
    },
  };
}

