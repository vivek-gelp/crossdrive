import Link from "next/link";
import { cookies } from "next/headers";
import { dropboxConfigured, env, googleClientProblem, microsoftConfigured } from "@/lib/config";
import { csrfToken } from "@/lib/csrf";
import { ADMIN_COOKIE, adminEmail } from "@/lib/http";
import { accountStatus, type AccountStatus } from "@/lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * Admin page. Plain semantic HTML with stable class names (card, btn, btn-primary, btn-danger, badge, badge-ok,
 * badge-warn, badge-err, field, stack, row, muted) so it can be styled without touching the logic. Every mutating
 * control is a POST form to /connect/action carrying the per-session CSRF token. Confirmation steps use <details>,
 * so they work on phones without JavaScript.
 */

function Hidden({ csrf, action, label, value }: { csrf: string; action: string; label?: string; value?: string }) {
  return (
    <>
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="action" value={action} />
      {label !== undefined && <input type="hidden" name="label" value={label} />}
      {value !== undefined && <input type="hidden" name="value" value={value} />}
    </>
  );
}

function AccountCard({ a, csrf }: { a: AccountStatus; csrf: string }) {
  const nextMode = a.mode === "write" ? "read" : "write";
  return (
    <article className="card stack" id={`account-${a.label}`}>
      <header className="row">
        <h3>
          <code>{a.label}</code>
        </h3>
        <span className="badge">{a.provider}</span>
        <span className={`badge ${a.mode === "write" ? "badge-ok" : "badge-warn"}`}>{a.mode === "write" ? "read + write" : "read-only"}</span>
        <span className={`badge ${a.mail === "send" ? "badge-warn" : a.mail === "draft" ? "badge-ok" : ""}`}>mail: {a.mail}</span>
        {a.token.ok ? (
          <span className="badge badge-ok">token ok</span>
        ) : (
          <span className="badge badge-err">token error</span>
        )}
      </header>
      <dl className="stack">
        <div className="row">
          <dt>E-mail</dt>
          <dd>{a.email}</dd>
        </div>
        <div className="row">
          <dt>Connected</dt>
          <dd>
            {a.connectedAt.slice(0, 10)} <span className="muted">({a.ageDays} days ago)</span>
          </dd>
        </div>
        <div className="row">
          <dt>Scopes</dt>
          <dd>{a.scopes.join(", ")}</dd>
        </div>
        <div className="row">
          <dt>Token</dt>
          <dd>
            {a.token.ok ? `ok (checked ${a.token.checkedAt.slice(11, 19)} UTC)` : a.token.error}
          </dd>
        </div>
      </dl>
      <div className="row">
        <form method="post" action="/connect/action">
          <Hidden csrf={csrf} action="mode" label={a.label} value={nextMode} />
          <button type="submit" className="btn">
            {nextMode === "read" ? "Make read-only" : "Allow writes"}
          </button>
        </form>
        {a.provider === "google" && (
          <form method="post" action="/connect/action" className="row">
            <Hidden csrf={csrf} action="mail" label={a.label} />
            <label className="field">
              Mail{" "}
              <select name="value" defaultValue={a.mail}>
                <option value="off">off</option>
                <option value="draft">draft only</option>
                <option value="send">draft and send</option>
              </select>
            </label>
            <button type="submit" className="btn">
              Save mail
            </button>
          </form>
        )}
        {a.provider === "google" ? (
          <a className="btn" href={`/connect/start?label=${encodeURIComponent(a.label)}&reconnect=1`}>
            {a.gmail ? "Reconnect" : "Reconnect (grant Gmail)"}
          </a>
        ) : (
          <a className="btn" href={`/connect/${a.provider}/start?label=${encodeURIComponent(a.label)}&reconnect=1`}>
            Reconnect
          </a>
        )}
      </div>
      <details>
        <summary className="btn btn-danger">Disconnect…</summary>
        <form method="post" action="/connect/action" className="stack">
          <Hidden csrf={csrf} action="disconnect" label={a.label} />
          <p className="muted">
            Revokes Crossdrive&apos;s access at {a.provider} and deletes the stored token for <code>{a.label}</code>. Files are not touched.
          </p>
          <button type="submit" className="btn btn-danger">
            Disconnect {a.label}
          </button>
        </form>
      </details>
    </article>
  );
}

export default async function ConnectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const notice = typeof sp.connected === "string" ? `Connected "${sp.connected}".` : typeof sp.notice === "string" ? sp.notice : null;
  const error = typeof sp.error === "string" ? sp.error : null;
  const email = await adminEmail();
  const googleProblem = googleClientProblem();
  const google = googleProblem === null;

  if (!email) {
    return (
      <main className="stack">
        <h1>Crossdrive — Connect</h1>
        <p>Sign in with an allowed Google account to manage connected accounts.</p>
        {error && <p className="badge badge-err">{error}</p>}
        {google ? (
          <p>
            <a href="/connect/login" className="btn btn-primary">
              Sign in with Google
            </a>
          </p>
        ) : (
          <p className="badge badge-err">
            {googleProblem} See <a href="/setup">/setup</a>.
          </p>
        )}
        <p>
          <Link href="/">Home</Link> · <a href="/setup">Setup</a>
        </p>
      </main>
    );
  }

  const session = (await cookies()).get(ADMIN_COOKIE)?.value ?? "";
  const csrf = csrfToken(session, env("JWT_SECRET") ?? "");
  const { accounts, warnings } = await accountStatus();
  const ms = microsoftConfigured();
  const dbx = dropboxConfigured();

  return (
    <main className="stack">
      <h1>Crossdrive — Connect</h1>
      <p>
        Signed in as <b>{email}</b>.
      </p>
      {notice && <p className="badge badge-ok">{notice}</p>}
      {error && <p className="badge badge-err">{error}</p>}
      {warnings.length > 0 && (
        <ul className="stack">
          {warnings.map((w) => (
            <li key={w} className="badge badge-warn">
              {w}
            </li>
          ))}
        </ul>
      )}

      <section className="stack">
        <h2>Connected accounts</h2>
        {accounts.length === 0 ? <p className="muted">None yet.</p> : accounts.map((a) => <AccountCard key={a.label} a={a} csrf={csrf} />)}
      </section>

      <section className="card stack">
        <h2>Add an account</h2>
        <p className="muted">
          Pick a short label: it prefixes every path (<code>work:/Projects</code>). Lower-case letters, digits and hyphens, starting with a
          letter. New Google accounts start with read + write and mail as drafts only; change that on the card afterwards.
        </p>
        <form method="get" action="/connect/start" className="stack">
          <label className="field">
            Label
            <input name="label" required pattern="[a-z][a-z0-9\-]{0,23}" maxLength={24} placeholder="work" autoCapitalize="none" autoCorrect="off" />
          </label>
          <label className="field">
            E-mail (optional, pre-selects the account at sign-in)
            <input name="email" type="email" maxLength={254} placeholder="alex@example.com" />
          </label>
          <div className="row">
            {google && (
              <button type="submit" className="btn btn-primary">
                Connect Google
              </button>
            )}
            {ms && (
              <button type="submit" formAction="/connect/microsoft/start" className="btn">
                Connect Microsoft
              </button>
            )}
            {dbx && (
              <button type="submit" formAction="/connect/dropbox/start" className="btn">
                Connect Dropbox
              </button>
            )}
          </div>
          {(ms || dbx) && <p className="muted">Microsoft (OneDrive) and Dropbox support is beta and not yet tested against live accounts.</p>}
        </form>
      </section>

      {accounts.length > 0 && (
        <section className="card stack">
          <h2>Disconnect everything</h2>
          <p className="muted">Kill switch: revokes every connected account&apos;s access and deletes all stored tokens. AI clients keep their Crossdrive login but see no accounts; to sign them out as well, rotate CROSSDRIVE_JWT_SECRET and redeploy.</p>
          <details>
            <summary className="btn btn-danger">Disconnect everything…</summary>
            <form method="post" action="/connect/action" className="stack">
              <Hidden csrf={csrf} action="disconnect-all" />
              <label className="row">
                <input type="checkbox" name="confirm" value="yes" required /> Yes, disconnect all {accounts.length} account(s)
              </label>
              <button type="submit" className="btn btn-danger">
                Disconnect everything
              </button>
            </form>
          </details>
        </section>
      )}

      <p>
        <Link href="/">Home</Link> · <a href="/setup">Setup</a> · <a href="/health">Health</a>
      </p>
    </main>
  );
}
