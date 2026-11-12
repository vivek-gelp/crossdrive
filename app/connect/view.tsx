import Link from "next/link";
import {
  adminNotConnected,
  availableLabelSuggestions,
  connectedMessage,
  describeConnectError,
  progressSteps,
  suggestLabelFor,
} from "@/lib/connect-ui";
import type { AccountStatus } from "@/lib/status";

/*
 * Presentational parts of /connect. Plain semantic HTML with stable class names (card, btn, btn-primary, btn-danger,
 * badge, badge-ok, badge-warn, badge-err, field, stack, row, muted, plus notice, card-primary, steps) so it can be
 * styled without touching the logic. Every mutating control is a POST form to /connect/action carrying the per-session
 * CSRF token; connecting is a GET to the provider's start route. Confirmation steps use <details>, so they work on
 * phones without JavaScript. Everything rendered from the query string goes through React's text escaping.
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

export function Steps({ signedIn, connected }: { signedIn: boolean; connected: number }) {
  return (
    <ol className="steps" aria-label="Progress">
      {progressSteps(signedIn, connected).map((s, i) => (
        <li key={s.label} className={`step-${s.state}`}>
          <span className="step-n">{i + 1}</span> {s.label}
          {s.state === "done" && <span className="visually-hidden"> (done)</span>}
          {s.state === "next" && <span className="step-tag">next</span>}
        </li>
      ))}
    </ol>
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
        {a.token.ok ? <span className="badge badge-ok">token ok</span> : <span className="badge badge-err">token error</span>}
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
          <dd>{a.token.ok ? `ok (checked ${a.token.checkedAt.slice(11, 19)} UTC)` : a.token.error}</dd>
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

export function SignedOutView({ error, googleProblem }: { error: string | null; googleProblem: string | null }) {
  return (
    <main className="stack">
      <Steps signedIn={false} connected={0} />
      <h1>Connect a cloud account</h1>
      <ol className="stack">
        <li>Sign in to manage this instance.</li>
        <li>Then connect each cloud account under a label. Signing in does not connect anything by itself.</li>
      </ol>
      {error && (
        <p className="notice notice-err" role="alert">
          {describeConnectError(error)}
        </p>
      )}
      {googleProblem === null ? (
        <p>
          <a href="/connect/login" className="btn btn-primary">
            Step 1: Sign in with Google
          </a>
        </p>
      ) : (
        <p className="notice notice-err">
          {googleProblem} See <a href="/setup">/setup</a>.
        </p>
      )}
      <p>
        <Link href="/">Home</Link> · <a href="/setup">Setup</a>
      </p>
    </main>
  );
}

export interface AdminViewProps {
  email: string;
  csrf: string;
  accounts: AccountStatus[];
  warnings: string[];
  google: boolean;
  microsoft: boolean;
  dropbox: boolean;
  mcpUrl: string;
  /** `connected=` from a provider callback. */
  connected: string | null;
  /** `notice=` from /connect/action. */
  notice: string | null;
  error: string | null;
  prefill: { label?: string; email?: string };
}

export function AdminView(p: AdminViewProps) {
  const { email, csrf, accounts } = p;
  const labels = accounts.map((a) => a.label);
  const suggestions = availableLabelSuggestions(labels);
  const meMissing = p.google && adminNotConnected(email, accounts);
  const meLabel = suggestLabelFor(email, labels);
  const none = accounts.length === 0;
  // With nothing connected the add form is the only primary control, so it carries the admin's own account.
  const formEmail = p.prefill.email ?? (none && meMissing ? email : undefined);
  const formLabel = p.prefill.label ?? (none && meMissing ? meLabel : undefined);
  const justConnected = p.connected ? accounts.find((a) => a.label === p.connected) : undefined;

  return (
    <main className="stack">
      <Steps signedIn connected={accounts.length} />
      <h1>Connect a cloud account</h1>
      <p className="muted">
        Signed in as <b>{email}</b> to manage this instance.
      </p>

      {p.connected && (
        <section className="notice notice-ok stack" role="status">
          <p>
            <b>{connectedMessage(p.connected, justConnected)}</b>
          </p>
          <p>Next: connect another account below, or add this URL to your AI client as a custom connector (remote MCP server):</p>
          <pre className="endpoint" aria-label="MCP endpoint URL" title="Click to select">
            <code>{p.mcpUrl}</code>
          </pre>
        </section>
      )}
      {p.notice && (
        <p className="notice notice-ok" role="status">
          {p.notice}
        </p>
      )}
      {p.error && (
        <p className="notice notice-err" role="alert">
          <b>Not connected.</b> {describeConnectError(p.error)}
        </p>
      )}

      {meMissing && (
        <section className="notice notice-warn stack">
          <p>
            You are signed in as <b>{email}</b>. Signing in only opens this admin page — <b>{email}</b> is not connected yet.
          </p>
          {none ? (
            <p>The form below is filled in for it; check the label and press Connect Google.</p>
          ) : (
            <form method="get" action="/connect/start" className="row">
              <input type="hidden" name="email" value={email} />
              <label className="row" htmlFor="me-label">
                Connect {email} as
              </label>
              <input
                id="me-label"
                className="input-label"
                name="label"
                required
                pattern="[a-z][a-z0-9\-]{0,23}"
                maxLength={24}
                defaultValue={meLabel}
                autoCapitalize="none"
                autoCorrect="off"
                aria-label="Label"
                autoFocus
              />
              <button type="submit" className="btn btn-primary">
                Connect
              </button>
            </form>
          )}
        </section>
      )}

      {p.warnings.length > 0 && (
        <div className="stack">
          {p.warnings.map((w) => (
            <p key={w} className="notice notice-warn">
              {w}
            </p>
          ))}
        </div>
      )}

      <section className="card card-primary stack" id="add">
        <h2>{none ? "Connect your first account" : "Add an account"}</h2>
        {none && <p>No accounts are connected yet, so your AI client would see nothing. Connect one here.</p>}
        <p className="muted">
          New Google accounts start with read + write and mail as drafts only; change that on the account&apos;s card afterwards.
        </p>
        <form method="get" action="/connect/start" className="stack">
          <label className="field">
            <span>Label</span>
            <input
              name="label"
              required
              pattern="[a-z][a-z0-9\-]{0,23}"
              maxLength={24}
              placeholder={suggestions[0] ?? "work"}
              defaultValue={formLabel}
              list="label-suggestions"
              autoCapitalize="none"
              autoCorrect="off"
            />
            <small>
              A short name you choose, e.g. <code>work</code> or <code>personal</code>. You will address files as <code>work:/Folder</code>.
              Lower-case letters, digits and hyphens, starting with a letter.
            </small>
          </label>
          <datalist id="label-suggestions">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          {suggestions.length > 0 && (
            <p className="row chips">
              <span className="muted">Suggestions:</span>
              {suggestions.map((s) => (
                <a key={s} className="chip" href={`/connect?label=${s}${formEmail ? `&email=${encodeURIComponent(formEmail)}` : ""}#add`}>
                  {s}
                </a>
              ))}
            </p>
          )}
          <label className="field">
            <span>E-mail (optional)</span>
            <input name="email" type="email" maxLength={254} placeholder="alex@example.com" defaultValue={formEmail} />
            <small>Optional: pre-selects this Google account on the next screen.</small>
          </label>
          <div className="row">
            {p.google && (
              <button type="submit" className="btn btn-primary">
                Connect Google
              </button>
            )}
            {p.microsoft && (
              <button type="submit" formAction="/connect/microsoft/start" className="btn">
                Connect Microsoft
              </button>
            )}
            {p.dropbox && (
              <button type="submit" formAction="/connect/dropbox/start" className="btn">
                Connect Dropbox
              </button>
            )}
          </div>
          {(p.microsoft || p.dropbox) && <p className="muted">Microsoft (OneDrive) and Dropbox support is beta and not yet tested against live accounts.</p>}
        </form>
      </section>

      <section className="stack">
        <h2>Connected accounts</h2>
        {none ? <p className="muted">None yet.</p> : accounts.map((a) => <AccountCard key={a.label} a={a} csrf={csrf} />)}
      </section>

      {!none && (
        <section className="card stack">
          <h2>Add Crossdrive to your AI client</h2>
          <p className="muted">Add this URL as a custom connector (remote MCP server). The client asks you to sign in and approve it.</p>
          <pre className="endpoint" aria-label="MCP endpoint URL" title="Click to select">
            <code>{p.mcpUrl}</code>
          </pre>
        </section>
      )}

      {!none && (
        <section className="card stack">
          <h2>Disconnect everything</h2>
          <p className="muted">
            Kill switch: revokes every connected account&apos;s access and deletes all stored tokens. AI clients keep their Crossdrive login
            but see no accounts; to sign them out as well, rotate CROSSDRIVE_JWT_SECRET and redeploy.
          </p>
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
