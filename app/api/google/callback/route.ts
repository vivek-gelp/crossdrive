import { NextResponse } from "next/server";
import { jwtEnv } from "@/lib/config";
import { connectedAccountRecord } from "@/lib/accounts";
import { appendAudit } from "@/lib/audit";
import { driveRedirectUri, exchangeCode, parseGrantedScopes, verifyGoogleIdToken } from "@/lib/google";
import { adminEmail, htmlError } from "@/lib/http";
import { verifyState } from "@/lib/jwt";
import { loadAccounts, upsertAccount } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Receives Drive + Gmail consent; stores {label, email, refresh_token, scopes, provider, mode, mail} encrypted. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/connect?${q}`, url.origin), 302);

  const admin = await adminEmail();
  if (!admin) return htmlError(401, "Admin session expired. Sign in again at /connect.");

  let state;
  try {
    state = await verifyState(jwtEnv(), url.searchParams.get("state") ?? "");
  } catch {
    return back(`error=${encodeURIComponent("Invalid or expired state; try again.")}`);
  }
  if (state.purpose !== "drive") return back(`error=${encodeURIComponent("Unexpected state")}`);

  const err = url.searchParams.get("error");
  if (err) return back(`error=${encodeURIComponent(`Google consent failed: ${err}`)}`);
  const code = url.searchParams.get("code");
  if (!code) return back(`error=${encodeURIComponent("Missing code from Google")}`);

  try {
    const tokens = await exchangeCode(code, driveRedirectUri());
    if (!tokens.refresh_token) throw new Error("Google did not return a refresh token; remove the app from the Google account's permissions and retry.");
    if (!tokens.id_token) throw new Error("Google did not return an id_token");
    const scopes = parseGrantedScopes(tokens.scope);
    if (!scopes.includes("drive")) throw new Error("Drive scope was not granted");
    const { email } = await verifyGoogleIdToken(tokens.id_token);
    const existing = (await loadAccounts(true)).find((a) => a.label === state.label);
    await upsertAccount(
      connectedAccountRecord({ label: state.label, email, refresh_token: tokens.refresh_token, scopes, provider: "google" }, existing),
    );
    await appendAudit({ tool: existing ? "admin_reconnect" : "admin_connect", account: state.label, actor: admin, email, note: `scopes=${scopes.join(",")}` });
    return back(`connected=${encodeURIComponent(state.label)}`);
  } catch (e) {
    return back(`error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
}
