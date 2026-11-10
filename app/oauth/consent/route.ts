import { NextResponse } from "next/server";
import { baseUrl } from "@/lib/config";
import { decideConsent } from "@/lib/consent";
import { originAllowed } from "@/lib/csrf";
import { htmlError } from "@/lib/http";
import { OAuthError } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Approve / Deny from the consent screen. The signed consent token is the CSRF secret; Origin must be ours. */
export async function POST(req: Request) {
  if (!originAllowed(req.headers.get("origin"), [baseUrl(), new URL(req.url).origin])) {
    return htmlError(403, "Consent must be given from this site.");
  }
  try {
    const form = new URLSearchParams(await req.text());
    const location = await decideConsent(form);
    return NextResponse.redirect(location, { status: 303, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof OAuthError) return htmlError(e.status, e.description);
    return htmlError(500, e instanceof Error ? e.message : "Unexpected error");
  }
}
