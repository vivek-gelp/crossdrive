import { cookies } from "next/headers";
import { baseUrl, dropboxConfigured, env, googleClientProblem, microsoftConfigured } from "@/lib/config";
import { prefillEmail, prefillLabel } from "@/lib/connect-ui";
import { csrfToken } from "@/lib/csrf";
import { ADMIN_COOKIE, adminEmail } from "@/lib/http";
import { accountStatus, NO_ACCOUNTS_WARNING } from "@/lib/status";
import { AdminView, SignedOutView } from "./view";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Admin page. Two steps, kept visibly separate: signing in (admin session only) and connecting each cloud account
 * under a label. Data is gathered here; the markup lives in ./view.tsx.
 */
export default async function ConnectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : null);
  const error = str("error");
  const email = await adminEmail();
  const googleProblem = googleClientProblem();

  if (!email) return <SignedOutView error={error} googleProblem={googleProblem} />;

  const session = (await cookies()).get(ADMIN_COOKIE)?.value ?? "";
  const csrf = csrfToken(session, env("JWT_SECRET") ?? "");
  const status = await accountStatus();

  return (
    <AdminView
      email={email}
      csrf={csrf}
      accounts={status.accounts}
      warnings={status.warnings.filter((w) => w !== NO_ACCOUNTS_WARNING)}
      google={googleProblem === null}
      microsoft={microsoftConfigured()}
      dropbox={dropboxConfigured()}
      mcpUrl={`${baseUrl()}/api/mcp`}
      connected={str("connected")}
      notice={str("notice")}
      error={error}
      prefill={{ label: prefillLabel(sp.label), email: prefillEmail(sp.email) }}
    />
  );
}
