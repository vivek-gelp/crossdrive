import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { googleClientProblem, jwtEnv } from "./config";
import { issueAdminSession, verifyAdminSession, TTL } from "./jwt";
import { OAuthError } from "./oauth";

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};

export function json(data: unknown, init: ResponseInit = {}): NextResponse {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  headers.set("Cache-Control", "no-store");
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new NextResponse(JSON.stringify(data), { ...init, headers });
}

export function corsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export function oauthErrorResponse(e: unknown): NextResponse {
  if (e instanceof OAuthError) return json(e.toJSON(), { status: e.status });
  const message = e instanceof Error ? e.message : String(e);
  return json({ error: "server_error", error_description: message }, { status: 500 });
}

/** Parse form-encoded or JSON bodies into URLSearchParams. */
export async function readForm(req: Request): Promise<URLSearchParams> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const body = (await req.json()) as Record<string, unknown>;
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) if (v !== undefined && v !== null) p.set(k, String(v));
    return p;
  }
  return new URLSearchParams(await req.text());
}

// ---- admin session cookie --------------------------------------------------

// Cookie name predates the rename to Crossdrive; kept so existing admin sessions survive an upgrade.
export const ADMIN_COOKIE = "vault_admin";

export async function adminEmail(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (!token) return null;
  try {
    return (await verifyAdminSession(jwtEnv(), token)).email;
  } catch {
    return null;
  }
}

export async function adminCookieHeader(email: string): Promise<string> {
  const token = await issueAdminSession(jwtEnv(), { email });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL.admin}${secure}`;
}

export function htmlError(status: number, message: string): NextResponse {
  const safe = message.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  return new NextResponse(
    `<!doctype html><html><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h1>Crossdrive</h1><p>${safe}</p><p><a href="/">Home</a></p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/**
 * Configuration error page for routes that would redirect to Google: a missing, placeholder or malformed client
 * only earns a Google "Error 401: invalid_client" screen, so say what is wrong here and point to /setup.
 */
export function googleConfigError(): NextResponse | null {
  const problem = googleClientProblem();
  if (!problem) return null;
  const safe = problem.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
  return new NextResponse(
    `<!doctype html><html><body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px"><h1>Crossdrive is not configured yet</h1><p>${safe}</p><p><a href="/setup">Open the setup checklist</a> · <a href="/">Home</a></p></body></html>`,
    { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}
