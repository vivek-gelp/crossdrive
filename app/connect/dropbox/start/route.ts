import { NextResponse } from "next/server";
import { adminEmail, htmlError } from "@/lib/http";
import { connectStartUrl } from "@/lib/providers/connect";
import { loadAccounts } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/**
 * Begin the Dropbox consent flow for one labelled account (admin only), with the same query parameters as the
 * Google flow and the /connect page: ?label=<label>[&reconnect=1]. Dropbox has no account hint, so `email` is ignored.
 * An existing label is only replaced when reconnect=1 (the card's Reconnect button).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const label = (url.searchParams.get("label") ?? "").trim().toLowerCase();
  const reconnect = url.searchParams.get("reconnect") === "1";
  const email = (url.searchParams.get("email") ?? url.searchParams.get("login_hint") ?? "").trim();
  const back = (msg: string) => NextResponse.redirect(new URL(`/connect?error=${encodeURIComponent(msg)}`, url.origin), 303);
  const admin = await adminEmail();
  if (!admin) {
    const next = `/connect/dropbox/start?${url.searchParams.toString()}`;
    return NextResponse.redirect(new URL(`/connect/login?next=${encodeURIComponent(next)}`, url.origin), 302);
  }
  if (email && !EMAIL_RE.test(email)) return back("That e-mail address does not look valid.");
  try {
    const existing = (await loadAccounts(true)).find((a) => a.label === label);
    if (existing && !reconnect) return back(`"${label}" is already connected. Use Reconnect on its card, or pick another label.`);
    const target = await connectStartUrl("dropbox", label, admin, undefined);
    return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return htmlError(400, e instanceof Error ? e.message : "Unexpected error");
  }
}
