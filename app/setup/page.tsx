import Link from "next/link";
import { headers } from "next/headers";
import { baseUrl, dropboxConfigured, env, microsoftConfigured } from "@/lib/config";
import { googleRedirectUris, setupChecks } from "@/lib/setup";
import { loadAccounts } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** First-run doctor. Public: shows pass/fail and counts only, never env values, labels or e-mails. */
export default async function SetupPage() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const requestOrigin = `${proto}://${host}`;
  let accounts: number | null = null;
  try {
    accounts = env("ENC_KEY") ? (await loadAccounts()).length : 0;
  } catch {
    accounts = null;
  }
  const checks = setupChecks({ env: process.env, requestOrigin, accounts });
  const base = env("BASE_URL") ? baseUrl() : requestOrigin;
  const providerRedirects = [
    ...(microsoftConfigured() ? [{ name: "Microsoft (Azure app, platform Web)", uri: `${base}/connect/microsoft/callback` }] : []),
    ...(dropboxConfigured() ? [{ name: "Dropbox app (OAuth 2 redirect URIs)", uri: `${base}/connect/dropbox/callback` }] : []),
  ];
  const failing = checks.filter((c) => c.ok === false).length;

  return (
    <main className="stack">
      <h1>Crossdrive — Setup</h1>
      <p className={`badge ${failing ? "badge-warn" : "badge-ok"}`}>
        {failing ? `${failing} item(s) need attention.` : "Everything that can be checked automatically passes."}
      </p>
      <ul className="stack">
        {checks.map((c) => (
          <li key={c.id} className="row">
            <span className={`badge ${c.ok === true ? "badge-ok" : c.ok === false ? "badge-err" : "badge-warn"}`}>
              {c.ok === true ? "pass" : c.ok === false ? "fail" : "check"}
            </span>
            <span>
              {c.title}
              {c.detail && <span className="muted"> — {c.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
      <section className="card stack">
        <h2>Google Cloud redirect URIs</h2>
        <p className="muted">Paste both into the OAuth client (type: Web application) under Authorized redirect URIs:</p>
        <ul>
          {googleRedirectUris(base).map((u) => (
            <li key={u}>
              <code>{u}</code>
            </li>
          ))}
        </ul>
        <p className="muted">
          MCP clients connect to <code>{base}/api/mcp</code>.
        </p>
      </section>
      {providerRedirects.length > 0 && (
        <section className="card stack">
          <h2>Beta provider redirect URIs</h2>
          <p className="muted">OneDrive and Dropbox support is beta and has not yet been tested against live accounts.</p>
          <ul>
            {providerRedirects.map((p) => (
              <li key={p.uri}>
                {p.name}: <code>{p.uri}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p>
        <Link href="/">Home</Link> · <a href="/connect">Connect</a> · <a href="/health">Health</a>
      </p>
    </main>
  );
}
