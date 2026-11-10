import { NextResponse } from "next/server";
import { jwtEnv } from "@/lib/config";
import { googleLoginUrl } from "@/lib/google";
import { htmlError } from "@/lib/http";
import { issueState } from "@/lib/jwt";
import { OAuthError, redirectWithParams, validateAuthorizeRequest } from "@/lib/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  try {
    const a = await validateAuthorizeRequest(params);
    const state = await issueState(jwtEnv(), {
      purpose: "oauth",
      client_id: a.client_id,
      redirect_uri: a.redirect_uri,
      code_challenge: a.code_challenge,
      state: a.state,
      scope: a.scope,
    });
    return NextResponse.redirect(googleLoginUrl(state), { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof OAuthError) {
      // Only redirect errors back when the redirect_uri itself was validated.
      const redirectOk = e.code !== "invalid_client" && e.code !== "invalid_request" ? params.get("redirect_uri") : null;
      if (redirectOk && !e.description.includes("redirect_uri")) {
        return NextResponse.redirect(
          redirectWithParams(redirectOk, { error: e.code, error_description: e.description, state: params.get("state") ?? undefined }),
          { status: 302 },
        );
      }
      return htmlError(e.status, `${e.code}: ${e.description}`);
    }
    return htmlError(500, e instanceof Error ? e.message : "Unexpected error");
  }
}
