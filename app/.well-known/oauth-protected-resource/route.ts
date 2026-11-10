import { corsPreflight, json } from "@/lib/http";
import { protectedResourceMetadata } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return json(protectedResourceMetadata(), { headers: { "Cache-Control": "public, max-age=3600" } });
}

export function OPTIONS() {
  return corsPreflight();
}
