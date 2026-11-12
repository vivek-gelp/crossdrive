import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * CSRF protection for the admin forms on /connect. Two independent checks, both required:
 *  1. A per-session token: HMAC-SHA256(CROSSDRIVE_JWT_SECRET, "csrf:" + admin session cookie). It changes with every
 *     sign-in, needs no storage, and a cross-site page cannot read it. The session cookie is HttpOnly and
 *     SameSite=Lax, so a cross-site POST does not carry it either.
 *  2. Origin: when the browser names a real origin it must be this deployment's own origin. `Origin: null` (sent by
 *     browsers under `Referrer-Policy: no-referrer`, from sandboxed frames and after some redirects) and a missing
 *     header carry no information; such requests pass this check and rely on the token alone.
 */

export function csrfToken(sessionToken: string, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64")).update(`csrf:${sessionToken}`).digest("base64url");
}

export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Origin header check. A foreign origin fails. A missing header and the opaque `Origin: null` pass: they prove
 * nothing either way, so every caller must also require a token bound to a cookie (checkCsrf, the consent cookie).
 */
export function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (origin === null || origin.trim() === "" || origin.trim() === "null") return true;
  return allowed.some((a) => {
    try {
      return new URL(a).origin === origin;
    } catch {
      return false;
    }
  });
}

/** `Sec-Fetch-Site: cross-site` is sent by current browsers even when Origin is withheld; it is always refused. */
export function fetchSiteAllowed(secFetchSite: string | null): boolean {
  return (secFetchSite ?? "").trim().toLowerCase() !== "cross-site";
}

export function checkCsrf(opts: {
  origin: string | null;
  allowedOrigins: string[];
  sessionToken: string | undefined;
  formToken: string | null;
  secret: string;
  /** Sec-Fetch-Site request header, when sent. */
  secFetchSite?: string | null;
}): string | null {
  if (!originAllowed(opts.origin, opts.allowedOrigins) || !fetchSiteAllowed(opts.secFetchSite ?? null)) {
    return "Request came from another site (Origin mismatch).";
  }
  if (!opts.sessionToken) return "Admin session expired. Sign in again.";
  if (!opts.formToken || !sameToken(opts.formToken, csrfToken(opts.sessionToken, opts.secret))) {
    return "Form token is missing or stale. Reload /connect and try again.";
  }
  return null;
}

/** Read one cookie from a raw Cookie header. */
export function cookieValue(header: string | null, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
