import { createHash, randomBytes } from "node:crypto";
import { jwtEnv } from "./config";
import { cookieValue, fetchSiteAllowed, originAllowed, sameToken } from "./csrf";
import { issueConsent, TTL, verifyConsent, type ConsentClaims, type PendingConsent } from "./jwt";
import { describeRedirect, issueCodeFor, OAuthError, redirectWithParams, SCOPE_FULL, SCOPE_READ } from "./oauth";
import { onceKey, useOnce } from "./once";

/**
 * Per-client consent screen for Crossdrive's own OAuth (confused-deputy protection). After the owner signs in with Google,
 * /oauth/google-callback shows this page instead of issuing a code. The pending request travels in a signed,
 * 10-minute `consent` JWT inside the form; /oauth/consent turns an approval into an authorization code.
 *
 * CSRF defence of the approval (it must not depend on the Origin header alone, which browsers send as `null` or
 * omit in several cases):
 *  1. Double submit: showing the page sets a random value in an HttpOnly, SameSite=Lax cookie scoped to
 *     /oauth/consent; the signed consent JWT carries its SHA-256. The POST must present both halves. A cross-site
 *     page can neither read the cookie nor make the browser send it on a cross-site POST.
 *  2. Origin / Sec-Fetch-Site: a request that names a foreign origin or says `cross-site` is refused outright.
 *     `Origin: null` or no Origin relies on (1).
 *  3. Single use: an approval or denial is recorded by the JWT's jti, so a captured form cannot be replayed.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export type { PendingConsent };

export const CONSENT_COOKIE_PREFIX = "crossdrive_consent_";
export const CONSENT_PATH = "/oauth/consent";

const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");

export interface IssuedConsent {
  /** The signed consent JWT for the form. */
  token: string;
  /** Set-Cookie header value that must accompany the page. */
  cookie: string;
}

/**
 * Sign a pending consent and bind it to this browser. `secure` adds the Secure attribute (always on https; plain-http
 * development on localhost goes without it). Each pending consent gets its own cookie name, so two consent screens
 * open in the same browser do not overwrite each other.
 */
export async function issuePendingConsent(p: PendingConsent, opts: { secure?: boolean } = {}): Promise<IssuedConsent> {
  const nonce = randomBytes(32).toString("base64url");
  const cn = randomBytes(6).toString("hex");
  const token = await issueConsent(jwtEnv(), { ...p, cn, csrf: sha256(nonce) });
  return { token, cookie: consentCookie(cn, nonce, TTL.consent, opts.secure ?? true) };
}

export function consentCookie(cn: string, value: string, maxAge: number, secure: boolean): string {
  return `${CONSENT_COOKIE_PREFIX}${cn}=${value}; Path=${CONSENT_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/**
 * Headers for the consent page: no framing (clickjacking), no caching, no full URL in the Referer (the page URL holds
 * Google's code). `strict-origin` still lets a same-origin form POST carry `Origin`; `no-referrer` made Chrome send
 * `Origin: null` instead, which broke Approve in 1.0.0. The page repeats the policy in a meta tag so the effective
 * policy is the same whichever Referrer-Policy header (this one or next.config.ts's site-wide one) ends up last.
 * No `form-action` directive: Chrome applies it to the redirect after the POST, which goes to the client.
 */
export const CONSENT_REFERRER_POLICY = "strict-origin";
export const CONSENT_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'",
  "Referrer-Policy": CONSENT_REFERRER_POLICY,
};

/** Inline styles (the CSP allows no external stylesheet); the colours follow app/ui.css. */
const CONSENT_CSS = `
:root{--bg:#f7f5f0;--surface:#fff;--text:#0e1116;--muted:#5a6068;--border:#dcd8cd;--accent:#0b6b63;--accent-c:#fff;--warn:#8a5300;--warn-bg:#fdefd3;--err:#b42318;--code-bg:#efece4;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--surface:#161a21;--text:#ece9e2;--muted:#9aa1ab;--border:#2a303a;--accent:#2fd4c3;--accent-c:#0e1116;--warn:#f7b955;--warn-bg:#33250c;--err:#ff8a7f;--code-bg:#1d222b;color-scheme:dark}}
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;overflow-wrap:break-word}
main{max-width:560px;margin:0 auto;padding:32px 16px 64px}
.brand{font-weight:600;font-size:1.1rem;color:var(--muted);margin:0 0 8px}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 16px}
.stack>*+*{margin-top:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px}
.muted{color:var(--muted);font-size:.95rem}
.badge{display:inline-block;font-size:.8rem;font-weight:600;padding:1px 8px;border-radius:999px;vertical-align:middle}
.badge-warn{background:var(--warn-bg);color:var(--warn)}
.client-name{font-size:1.15rem}
code{font-family:ui-monospace,"Cascadia Mono",Consolas,Menlo,monospace;font-size:.85rem;background:var(--code-bg);padding:1px 4px;border-radius:4px;word-break:break-all}
fieldset{border:1px solid var(--border);border-radius:6px;padding:8px 14px 12px;margin:0}
legend{font-weight:600;padding:0 4px}
label.row{display:flex;gap:10px;align-items:flex-start;margin-top:8px;cursor:pointer}
label.row input{margin-top:5px}
.actions{display:flex;flex-wrap:wrap;gap:12px}
.btn{font:inherit;font-weight:600;border-radius:6px;padding:10px 20px;cursor:pointer;border:1px solid transparent}
.btn-primary{background:var(--accent);color:var(--accent-c)}
.btn-danger{background:transparent;color:var(--err);border-color:var(--err)}
.btn:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
`;

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
    : `<label class="row"><input type="radio" name="access" value="full" checked> <span>Full access: read, write, share and send mail as configured per account</span></label>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="${CONSENT_REFERRER_POLICY}">
<title>Authorize client - Crossdrive</title><style>${CONSENT_CSS}</style></head>
<body><main class="stack">
<p class="brand">Crossdrive</p>
<h1>Authorize a client</h1>
<section class="card stack">
<p><strong class="client-name">${name}</strong> <span class="badge badge-warn">name not verified</span></p>
<p>wants access to your Crossdrive. The authorization will be sent to ${where}.</p>
<p class="muted">The client chose its own name; trust the redirect host, not the name. Signed in as ${escapeHtml(p.email)}.</p>
<p class="muted">Full redirect URI: <code>${escapeHtml(p.redirect_uri)}</code></p>
<form method="post" action="${CONSENT_PATH}" class="stack">
<input type="hidden" name="consent" value="${escapeHtml(token)}">
<fieldset class="field"><legend>Access</legend>
${fullOption}
<label class="row"><input type="radio" name="access" value="read"${readOnlyRequested ? " checked" : ""}> <span>Read-only: list, search and read; no changes, no mail sent</span></label>
</fieldset>
<div class="actions">
<button type="submit" name="decision" value="approve" class="btn btn-primary">Approve</button>
<button type="submit" name="decision" value="deny" class="btn btn-danger">Deny</button>
</div>
</form>
</section>
</main></body></html>`;
}

/** Thrown when the browser binding does not match: answered with 403. */
export class ConsentCsrfError extends Error {}

/**
 * Turn the consent form into the redirect back to the client. Approve issues a code with the chosen scope (never
 * wider than requested); deny returns access_denied. `cookieHeader` is the request's Cookie header: the consent
 * cookie must match the hash inside the token. Each consent token can be decided once. Throws OAuthError when the
 * consent token is bad or used, ConsentCsrfError when the browser binding does not match.
 */
export async function decideConsent(form: URLSearchParams, cookieHeader: string | null): Promise<string> {
  const token = form.get("consent") ?? "";
  let p: ConsentClaims;
  try {
    p = await verifyConsent(jwtEnv(), token);
  } catch {
    throw new OAuthError("invalid_request", "consent request is invalid or expired; start the connection again from the client");
  }
  const nonce = p.cn ? cookieValue(cookieHeader, `${CONSENT_COOKIE_PREFIX}${p.cn}`) : undefined;
  if (!p.cn || !p.csrf || !nonce || !sameToken(sha256(nonce), p.csrf)) {
    throw new ConsentCsrfError(
      "This approval did not come from the consent screen this browser was shown (the consent cookie is missing or does not match). " +
        "Start the connection again from the client, in the same browser, with cookies enabled for this site.",
    );
  }
  if (!(await useOnce("consent", onceKey(token, p.jti)))) {
    throw new OAuthError("invalid_request", "this consent screen was already answered; start the connection again from the client");
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

function htmlPage(status: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(
    `<!doctype html><html><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h1>Crossdrive</h1><p>${escapeHtml(message)}</p><p><a href="/">Home</a></p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders } },
  );
}

/** Expire the consent cookie named in the form's token (best effort: an unreadable token names none). */
function clearCookieFor(token: string, secure: boolean): Record<string, string> {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { cn?: unknown };
    if (typeof payload.cn === "string" && /^[0-9a-f]{12}$/.test(payload.cn)) return { "Set-Cookie": consentCookie(payload.cn, "", 0, secure) };
  } catch {
    /* nothing to clear */
  }
  return {};
}

/** POST /oauth/consent. `allowedOrigins`: this deployment's origins (base URL and the request's own origin). */
export async function handleConsentPost(req: Request, allowedOrigins: string[]): Promise<Response> {
  const origin = req.headers.get("origin");
  if (!originAllowed(origin, allowedOrigins) || !fetchSiteAllowed(req.headers.get("sec-fetch-site"))) {
    return htmlPage(
      403,
      `Consent must be given from this site; this request came from ${origin && origin !== "null" ? origin : "another site"}. Start the connection again from the client.`,
    );
  }
  const secure = allowedOrigins.some((o) => o.startsWith("https:"));
  const form = new URLSearchParams(await req.text());
  const clear = clearCookieFor(form.get("consent") ?? "", secure);
  try {
    const location = await decideConsent(form, req.headers.get("cookie"));
    return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", ...clear } });
  } catch (e) {
    if (e instanceof ConsentCsrfError) return htmlPage(403, e.message);
    if (e instanceof OAuthError) return htmlPage(e.status, e.description, clear);
    return htmlPage(500, e instanceof Error ? e.message : "Unexpected error");
  }
}
