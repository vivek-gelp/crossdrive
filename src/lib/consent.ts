import { jwtEnv } from "./config";
import { issueConsent, verifyConsent, type ConsentClaims, type PendingConsent } from "./jwt";
import { describeRedirect, issueCodeFor, OAuthError, redirectWithParams, SCOPE_FULL, SCOPE_READ } from "./oauth";

/**
 * Per-client consent screen for Crossdrive's own OAuth (confused-deputy protection). After the owner signs in with Google,
 * /oauth/google-callback shows this page instead of issuing a code. The pending request travels in a signed,
 * 10-minute `consent` JWT inside the form; /oauth/consent turns an approval into an authorization code.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export type { PendingConsent };

export function issuePendingConsent(p: PendingConsent): Promise<string> {
  return issueConsent(jwtEnv(), p);
}

/** Headers for the consent page: no framing (clickjacking), no caching, no referrer leaking the request. */
export const CONSENT_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'",
  "Referrer-Policy": "no-referrer",
};

export function renderConsentPage(p: PendingConsent, token: string): string {
  const r = describeRedirect(p.redirect_uri);
  const name = p.client_name ? escapeHtml(p.client_name) : "An unnamed client";
  const host = escapeHtml(r.host);
  const where =
    r.kind === "web"
      ? `the website <strong class="redirect-host">${host}</strong>`
      : r.kind === "loopback"
        ? `a program on this computer (<strong class="redirect-host">${host}</strong>)`
        : `the app registered for <strong class="redirect-host">${host}</strong>`;
  const readOnlyRequested = p.scope === SCOPE_READ;
  const fullOption = readOnlyRequested
    ? ""
    : `<label class="row"><input type="radio" name="access" value="full" checked> Full access: read, write, share and send mail as configured per account</label>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize client - Crossdrive</title></head>
<body><main class="stack">
<h1>Authorize a client</h1>
<section class="card stack">
<p><strong class="client-name">${name}</strong> <span class="badge badge-warn">name not verified</span></p>
<p>wants access to your Crossdrive. The authorization will be sent to ${where}.</p>
<p class="muted">The client chose its own name; trust the redirect host, not the name. Signed in as ${escapeHtml(p.email)}.</p>
<p class="muted">Full redirect URI: <code>${escapeHtml(p.redirect_uri)}</code></p>
<form method="post" action="/oauth/consent" class="stack">
<input type="hidden" name="consent" value="${escapeHtml(token)}">
<fieldset class="field stack"><legend>Access</legend>
${fullOption}
<label class="row"><input type="radio" name="access" value="read"${readOnlyRequested ? " checked" : ""}> Read-only: list, search and read; no changes, no mail sent</label>
</fieldset>
<div class="row">
<button type="submit" name="decision" value="approve" class="btn btn-primary">Approve</button>
<button type="submit" name="decision" value="deny" class="btn btn-danger">Deny</button>
</div>
</form>
</section>
</main></body></html>`;
}

/**
 * Turn the consent form into the redirect back to the client. Approve issues a code with the chosen scope (never
 * wider than requested); deny returns access_denied. Throws OAuthError when the consent token is bad.
 */
export async function decideConsent(form: URLSearchParams): Promise<string> {
  let p: ConsentClaims;
  try {
    p = await verifyConsent(jwtEnv(), form.get("consent") ?? "");
  } catch {
    throw new OAuthError("invalid_request", "consent request is invalid or expired; start the connection again from the client");
  }
  if (form.get("decision") !== "approve") {
    return redirectWithParams(p.redirect_uri, { error: "access_denied", error_description: "The owner denied access", state: p.state });
  }
  const access = form.get("access");
  const scope = access === "read" || p.scope === SCOPE_READ ? SCOPE_READ : access === "full" ? SCOPE_FULL : null;
  if (!scope) throw new OAuthError("invalid_request", "choose full or read-only access");
  const code = await issueCodeFor(
    { client_id: p.client_id, redirect_uri: p.redirect_uri, code_challenge: p.code_challenge, scope },
    p.email,
  );
  return redirectWithParams(p.redirect_uri, { code, state: p.state });
}
