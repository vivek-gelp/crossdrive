import { NextResponse } from "next/server";
import { jwtEnv } from "@/lib/config";
import { googleLoginUrl } from "@/lib/google";
import { googleConfigError, htmlError } from "@/lib/http";
import { issueState } from "@/lib/jwt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin login for /connect: Google Sign-In (openid email) with a signed state. */
export async function GET(req: Request) {
  const misconfigured = googleConfigError();
  if (misconfigured) return misconfigured;
  try {
    const next = new URL(req.url).searchParams.get("next") ?? "/connect";
    const state = await issueState(jwtEnv(), { purpose: "admin", next: next.startsWith("/") ? next : "/connect" });
    return NextResponse.redirect(googleLoginUrl(state), { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return htmlError(500, e instanceof Error ? e.message : "Unexpected error");
  }
}
