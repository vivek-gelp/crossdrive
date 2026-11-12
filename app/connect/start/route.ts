import { NextResponse } from "next/server";
import { isValidLabel, jwtEnv } from "@/lib/config";
import { googleConsentUrl } from "@/lib/google";
import { adminEmail, googleConfigError, htmlError } from "@/lib/http";
import { issueState } from "@/lib/jwt";
import { accountProvider, loadAccounts } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/**
 * Begin the Google Drive + Gmail consent flow for one labelled account (admin only). Nothing is stored here; the
 * callback stores the account only when the signed state comes back. `email` (optional) becomes Google's
 * `login_hint`; a reconnect always hints the stored e-mail.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const label = (url.searchParams.get("label") ?? "").trim().toLowerCase();
  const reconnect = url.searchParams.get("reconnect") === "1";
  const email = (url.searchParams.get("email") ?? "").trim();
  const back = (msg: string) => NextResponse.redirect(new URL(`/connect?error=${encodeURIComponent(msg)}`, url.origin), 303);

  if (!(await adminEmail())) {
    const next = `/connect/start?${url.searchParams.toString()}`;
    return NextResponse.redirect(new URL(`/connect/login?next=${encodeURIComponent(next)}`, url.origin), 302);
  }
  if (!isValidLabel(label)) {
    return back("Label must start with a letter and use only a-z, 0-9 and hyphens (max 24 characters).");
  }
  if (email && !EMAIL_RE.test(email)) return back("That e-mail address does not look valid.");
  const misconfigured = googleConfigError();
  if (misconfigured) return misconfigured;
  try {
    const existing = (await loadAccounts(true)).find((a) => a.label === label);
    if (existing && !reconnect) return back(`"${label}" is already connected. Use Reconnect on its card, or pick another label.`);
    if (existing && accountProvider(existing) !== "google") return back(`"${label}" is not a Google account; reconnect it with its own provider.`);
    const state = await issueState(jwtEnv(), { purpose: "drive", label });
    const loginHint = existing?.email ?? (email || undefined);
    return NextResponse.redirect(googleConsentUrl(state, { loginHint }), { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return htmlError(500, e instanceof Error ? e.message : "Unexpected error");
  }
}
