import { NextResponse } from "next/server";
import { adminEmail, htmlError } from "@/lib/http";
import { connectCallback } from "@/lib/providers/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Receives the Dropbox consent; stores {label, email, refresh_token, provider: "dropbox", mode: "write"} encrypted. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const back = (q: string) => NextResponse.redirect(new URL(`/connect?${q}`, url.origin), 302);
  const admin = await adminEmail();
  if (!admin) return htmlError(401, "Admin session expired. Sign in again at /connect.");
  try {
    const label = await connectCallback("dropbox", url.searchParams, admin);
    return back(`connected=${encodeURIComponent(label)}`);
  } catch (e) {
    return back(`error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
}
