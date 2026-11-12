import { NextResponse } from "next/server";
import { baseUrl, isAllowedEmail, jwtEnv } from "@/lib/config";
import { exchangeCode, loginRedirectUri, verifyGoogleIdToken } from "@/lib/google";
import { adminCookieHeader, htmlError } from "@/lib/http";
import { verifyState } from "@/lib/jwt";
import { ALREADY_ANSWERED, CONSENT_HEADERS, issuePendingConsent, renderConsentPage, type PendingConsent } from "@/lib/consent";
import { verifyClientId } from "@/lib/jwt";
import { redirectWithParams, SCOPE_FULL } from "@/lib/oauth";
import { onceKey, redeemOnce } from "@/lib/once";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Google Sign-In return. Serves two flows, distinguished by the signed state:
 *  - purpose "oauth": an MCP client is authorising; show the per-client consent screen (code issued by /oauth/consent).
 *  - purpose "admin": the /connect admin page login; set a session cookie.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const stateToken = url.searchParams.get("state") ?? "";
  let state;
  try {
    state = await verifyState(jwtEnv(), stateToken);
  } catch {
    return htmlError(400, "Invalid or expired state. Start the sign-in again.");
  }

  const fail = (status: number, message: string, code = "access_denied") => {
    if (state.purpose === "oauth") {
      return NextResponse.redirect(redirectWithParams(state.redirect_uri, { error: code, error_description: message, state: state.state }), 302);
    }
    return htmlError(status, message);
  };

  const googleError = url.searchParams.get("error");
  if (googleError) return fail(400, `Google sign-in failed: ${googleError}`);
  const code = url.searchParams.get("code");
  if (!code) return fail(400, "Missing code from Google");
  // Google's code is single-use and each consent screen is answered once. A repeat of this URL (browser Back after
  // the consent screen) gets a plain page, not a redirect: the client already received its answer.
  if (state.purpose === "oauth" && !(await redeemOnce("callback", onceKey(code, undefined)))) {
    return htmlError(409, ALREADY_ANSWERED);
  }

  let email: string;
  try {
    const tokens = await exchangeCode(code, loginRedirectUri());
    if (!tokens.id_token) throw new Error("no id_token");
    email = (await verifyGoogleIdToken(tokens.id_token)).email;
  } catch (e) {
    return fail(502, `Could not verify Google identity: ${e instanceof Error ? e.message : String(e)}`, "server_error");
  }
  if (!isAllowedEmail(email)) return fail(403, `${email} is not allowed to use this server.`);

  if (state.purpose === "oauth") {
    let client_name: string | undefined;
    try {
      client_name = (await verifyClientId(jwtEnv(), state.client_id)).client_name;
    } catch {
      return fail(400, "Unknown client", "invalid_client");
    }
    const pending: PendingConsent = {
      client_id: state.client_id,
      client_name,
      redirect_uri: state.redirect_uri,
      code_challenge: state.code_challenge,
      state: state.state,
      scope: state.scope ?? SCOPE_FULL,
      email,
    };
    // The cookie half of the consent CSRF binding; Secure whenever this deployment is served over https.
    const secure = [baseUrl(), url.origin].some((o) => o.startsWith("https:"));
    const { token, cookie } = await issuePendingConsent(pending, { secure });
    return new NextResponse(renderConsentPage(pending, token), { status: 200, headers: { ...CONSENT_HEADERS, "Set-Cookie": cookie } });
  }
  if (state.purpose === "admin") {
    const next = state.next && state.next.startsWith("/") ? state.next : "/connect";
    return NextResponse.redirect(new URL(next, url.origin), {
      status: 302,
      headers: { "Set-Cookie": await adminCookieHeader(email), "Cache-Control": "no-store" },
    });
  }
  return htmlError(400, "Unexpected state purpose");
}
