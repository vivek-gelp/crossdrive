import { corsPreflight, json } from "@/lib/http";
import { authorizationServerMetadata } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return json(authorizationServerMetadata(), { headers: { "Cache-Control": "public, max-age=3600" } });
}

export function OPTIONS() {
  return corsPreflight();
}
