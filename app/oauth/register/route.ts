import { corsPreflight, json, oauthErrorResponse } from "@/lib/http";
import { OAuthError, registerClient, type RegistrationRequest } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    let body: RegistrationRequest;
    try {
      body = (await req.json()) as RegistrationRequest;
    } catch {
      throw new OAuthError("invalid_client_metadata", "body must be JSON");
    }
    return json(await registerClient(body), { status: 201 });
  } catch (e) {
    return oauthErrorResponse(e);
  }
}

export function OPTIONS() {
  return corsPreflight();
}
