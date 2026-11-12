import { baseUrl } from "@/lib/config";
import { handleConsentPost } from "@/lib/consent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Approve / Deny from the consent screen. Protected by a double-submit cookie bound to the signed consent token, an
 * Origin / Sec-Fetch-Site check that refuses foreign origins, and single use (see src/lib/consent.ts).
 */
export async function POST(req: Request) {
  return handleConsentPost(req, [baseUrl(), new URL(req.url).origin]);
}
