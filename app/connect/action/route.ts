import { NextResponse } from "next/server";
import { baseUrl, env } from "@/lib/config";
import { disconnectAccount, disconnectAll, setAccountMail, setAccountMode, type DisconnectResult } from "@/lib/accounts";
import { checkCsrf, cookieValue } from "@/lib/csrf";
import { ADMIN_COOKIE, adminEmail } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function revokedText(r: DisconnectResult): string {
  return r.revoked === true ? "access revoked" : r.revoked === "shared" ? "grant kept for another label" : "revoke failed, removed anyway";
}

/**
 * All mutating /connect actions: POST + admin session + CSRF token bound to that session + Origin check (a foreign
 * Origin is refused; `Origin: null` or none relies on the token). Redirects back with a notice.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const back = (key: "notice" | "error", msg: string) =>
    NextResponse.redirect(new URL(`/connect?${key}=${encodeURIComponent(msg)}`, url.origin), { status: 303, headers: { "Cache-Control": "no-store" } });

  const admin = await adminEmail();
  if (!admin) return back("error", "Admin session expired. Sign in again.");
  const form = new URLSearchParams(await req.text());
  const csrfError = checkCsrf({
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    allowedOrigins: [baseUrl(), url.origin],
    sessionToken: cookieValue(req.headers.get("cookie"), ADMIN_COOKIE),
    formToken: form.get("csrf"),
    secret: env("JWT_SECRET") ?? "",
  });
  if (csrfError) return back("error", csrfError);

  const label = form.get("label") ?? "";
  const value = form.get("value") ?? "";
  try {
    switch (form.get("action")) {
      case "mode":
        await setAccountMode(label, value, admin);
        return back("notice", `${label}: mode set to ${value}.`);
      case "mail":
        await setAccountMail(label, value, admin);
        return back("notice", `${label}: mail set to ${value}.`);
      case "disconnect": {
        const r = await disconnectAccount(label, admin);
        return back("notice", `Disconnected ${r.label} (${revokedText(r)}).`);
      }
      case "disconnect-all": {
        if (form.get("confirm") !== "yes") return back("error", "Tick the confirmation box to disconnect everything.");
        const rs = await disconnectAll(admin);
        const failed = rs.filter((r) => r.revoked === false).map((r) => r.label);
        return back(
          "notice",
          `Disconnected ${rs.length} account(s).` + (failed.length ? ` Revoke failed for ${failed.join(", ")}; remove the app in those accounts' security settings.` : ""),
        );
      }
      default:
        return back("error", "Unknown action.");
    }
  } catch (e) {
    return back("error", e instanceof Error ? e.message : String(e));
  }
}
