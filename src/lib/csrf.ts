import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * CSRF protection for the admin forms on /connect. Two independent checks, both required:
 *  1. A per-session token: HMAC-SHA256(CROSSDRIVE_JWT_SECRET, "csrf:" + admin session cookie). It changes with every
 *     sign-in, needs no storage, and a cross-site page cannot read it.
 *  2. Origin: when the browser sends an Origin header it must be this deployment's own origin.
 */

export function csrfToken(sessionToken: string, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64")).update(`csrf:${sessionToken}`).digest("base64url");
}

export function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `Origin: null` (sandboxed frames, some redirects) and foreign origins fail; a missing header is allowed (token still required). */
export function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (origin === null) return true;
  return allowed.some((a) => {
    try {
      return new URL(a).origin === origin;
    } catch {
      return false;
    }
  });
}

export function checkCsrf(opts: {
  origin: string | null;
  allowedOrigins: string[];
  sessionToken: string | undefined;
  formToken: string | null;
  secret: string;
}): string | null {
  if (!originAllowed(opts.origin, opts.allowedOrigins)) return "Request came from another site (Origin mismatch).";
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
