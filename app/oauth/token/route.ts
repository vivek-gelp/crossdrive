import { corsPreflight, json, oauthErrorResponse, readForm } from "@/lib/http";
import { handleTokenRequest } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const form = await readForm(req);
    return json(await handleTokenRequest(form), { headers: { Pragma: "no-cache" } });
  } catch (e) {
    return oauthErrorResponse(e);
  }
}

export function OPTIONS() {
  return corsPreflight();
}
