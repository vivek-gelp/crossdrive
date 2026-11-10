/**
 * Logic behind /connect/{microsoft,dropbox}/{start,callback} (the route
 * files stay thin). Admin-only, like the Google connect flow: the caller
 * passes the admin email from the session cookie (http.ts adminEmail).
 */
import { connectedAccountRecord } from "../accounts";
import { appendAudit } from "../audit";
import { accountProvider, loadAccounts, upsertAccount, type Account } from "../store";
import { currentProviderFetch, isValidLabel } from "./env";
import { PROVIDER_NAMES } from "./index";
import { issueProviderState, verifyProviderState } from "./state";
import { clearProviderTokens, dropboxConsentUrl, exchangeDropboxCode, exchangeMicrosoftCode, microsoftConsentUrl, MS_SCOPES } from "./tokens";

export type ConnectProvider = "microsoft" | "dropbox";

async function assertLabelFree(label: string, provider: ConnectProvider): Promise<Account | undefined> {
  const existing = (await loadAccounts(true)).find((a) => a.label === label);
  if (existing && accountProvider(existing) !== provider) {
    throw new Error(`Label "${label}" is already used by a ${PROVIDER_NAMES[accountProvider(existing)]} account; pick another label or remove that account first.`);
  }
  return existing;
}

/** URL to send the admin to (the provider's consent screen). */
export async function connectStartUrl(provider: ConnectProvider, label: string, admin: string, loginHint?: string): Promise<string> {
  if (!isValidLabel(label)) throw new Error("label must match ^[a-z][a-z0-9-]{0,23}$ (lower-case letters, digits, dashes; starts with a letter)");
  const existing = await assertLabelFree(label, provider);
  const { state, challenge } = await issueProviderState({ provider, label, admin });
  if (provider === "microsoft") return microsoftConsentUrl(state, challenge, loginHint || existing?.email);
  return dropboxConsentUrl(state, challenge);
}

async function microsoftEmail(accessToken: string): Promise<string> {
  const res = await currentProviderFetch()("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Microsoft Graph /me failed (${res.status})`);
  const me = (await res.json()) as { mail?: string | null; userPrincipalName?: string };
  const email = me.mail || me.userPrincipalName;
  if (!email) throw new Error("Microsoft account has no e-mail or user principal name");
  return email.toLowerCase();
}

async function dropboxEmail(accessToken: string): Promise<string> {
  const res = await currentProviderFetch()("https://api.dropboxapi.com/2/users/get_current_account", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: "null",
  });
  if (!res.ok) throw new Error(`Dropbox get_current_account failed (${res.status})`);
  const me = (await res.json()) as { email?: string };
  if (!me.email) throw new Error("Dropbox account has no e-mail");
  return me.email.toLowerCase();
}

/** Handle the provider's redirect: verify state, exchange the code, store the account. Returns the label. */
export async function connectCallback(provider: ConnectProvider, params: URLSearchParams, admin: string): Promise<string> {
  const st = await verifyProviderState(params.get("state") ?? "", provider).catch(() => {
    throw new Error("Invalid or expired state; start again from /connect.");
  });
  if (st.admin !== admin) throw new Error("This consent was started by a different admin session.");
  const err = params.get("error");
  if (err) throw new Error(`${PROVIDER_NAMES[provider]} consent failed: ${params.get("error_description") ?? err}`.slice(0, 300));
  const code = params.get("code");
  if (!code) throw new Error(`Missing code from ${PROVIDER_NAMES[provider]}`);
  const existing = await assertLabelFree(st.label, provider);

  const tokens = provider === "microsoft" ? await exchangeMicrosoftCode(code, st.verifier) : await exchangeDropboxCode(code, st.verifier);
  if (!tokens.refresh_token) {
    throw new Error(provider === "microsoft" ? "Microsoft returned no refresh token (offline_access missing?)" : "Dropbox returned no refresh token (token_access_type=offline missing?)");
  }
  const email = provider === "microsoft" ? await microsoftEmail(tokens.access_token) : await dropboxEmail(tokens.access_token);
  const scopes = provider === "microsoft" ? [...MS_SCOPES] : (tokens.scope ?? "").split(/\s+/).filter(Boolean);
  // Same defaults as the Google connect: new accounts get mode "write" (mail "off": no mail for these providers); a reconnect keeps the mode.
  await upsertAccount(
    connectedAccountRecord({ label: st.label as Account["label"], email, refresh_token: tokens.refresh_token, scopes: scopes.length ? scopes : [provider], provider }, existing),
  );
  await appendAudit({ tool: existing ? "admin_reconnect" : "admin_connect", account: st.label, actor: admin, email, note: `provider=${provider}` }).catch(() => undefined);
  clearProviderTokens(st.label);
  return st.label;
}
