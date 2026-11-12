import Link from "next/link";
import { baseUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

const GITHUB = "https://github.com/vivek-gelp/crossdrive";

const WHAT = [
  {
    title: "Every account under a label",
    body: "Connect your Google accounts and give each a label. Every request names its account, as in work:/Finance/2026 or personal:/Taxes, so nothing is ever done in whichever account happens to be connected.",
  },
  {
    title: "Between accounts",
    body: "Copy or move files and whole folder trees from one account to another, with the source trashed only after a move is verified. Find duplicates across accounts, and search every account at once with any account that failed named. Between Google Drive, OneDrive and Dropbox this is beta and not yet tested against live accounts.",
  },
  {
    title: "Mail mode per account",
    body: "Each Gmail account is set to off, draft or send on its own, so a work account can stay draft-only while another may send. New accounts start at draft. Search, read, label and save attachments to the right folder.",
  },
  {
    title: "Not tied to one AI app",
    body: "It is a remote MCP server with OAuth, meant for any client that can add one, and your tokens stay in your own storage. So far only the Claude desktop app has been verified as a client; Claude Code, ChatGPT and others are untested.",
  },
];

const NEED = [
  "Rules per account, enforced on the server: read-only accounts, mail off, draft or send per account, trash-only delete, dry run, undo and an audit log.",
  "Work between accounts: copy or move files and folder trees, find duplicates across accounts, one search that names any account that failed.",
  "Your own hosting, not tied to one AI vendor: tokens in your own storage, and any MCP client can connect (only the Claude desktop app verified so far).",
  "OneDrive or Dropbox beside Google (beta, not yet tested on live accounts).",
];

const SAFETY = [
  {
    title: "Trash only",
    body: "There is no permanent-delete call in the code. Deleting means moving to the provider's trash, where you can restore it.",
  },
  {
    title: "Read-only accounts",
    body: "Mark any account read-only and the server rejects every write to it, whatever the assistant asks for. Copying out of it streams the files, so not even a temporary permission is added.",
  },
  {
    title: "Dry run, then undo",
    body: "Most writes can be previewed with a dry run first. Moves, renames and trashes are logged with an id that undo can roll back.",
  },
  {
    title: "Audit log",
    body: "Each write is recorded with time, client, account, action and file ids; mail entries add recipients and subject. File contents and mail bodies are not logged.",
  },
  {
    title: "Per-client consent",
    body: "No client gets a token until you sign in and approve it. Clients that should only look can be given read-only access.",
  },
  {
    title: "Content is data",
    body: "Text inside files and emails is returned as untrusted data. Instructions found in a document never become tool calls on their own.",
  },
];

export default function Home() {
  const endpoint = `${baseUrl()}/api/mcp`;
  return (
    <div className="stack" style={{ gap: 40 }}>
      <section className="hero">
        <h1>Every drive you own. One safe connection for your AI.</h1>
        <p className="sub">
          A guarded file-and-mail layer you host yourself. Every account sits under its own label, the server enforces
          the rules for each one, and files can be copied, moved and searched between accounts. Google Drive and
          Gmail, with OneDrive and Dropbox in beta.
        </p>
        <div className="row" style={{ marginTop: 24 }}>
          <Link href="/setup" className="btn btn-primary">
            Set up this instance
          </Link>
          <a href={GITHUB} className="btn" rel="noopener">
            View on GitHub
          </a>
        </div>

        <div className="demo" role="img" aria-label="Example: an assistant previews and then runs a copy of an invoices folder from one drive to another">
          <div className="demo-bar">
            <i style={{ background: "var(--teal)" }} />
            <i style={{ background: "var(--amber)" }} />
            <span style={{ marginLeft: 8 }}>assistant · crossdrive</span>
          </div>
          <div className="demo-body">
            <p>
              <span className="you">you</span>
              {"\n"}Copy last year&apos;s invoices from my personal drive into the company drive.
            </p>
            <p>
              <span className="who">crossdrive · copy · dry run</span>
              {"\n"}from personal:/Invoices/2025
              {"\n"}to{"   "}work:/Finance/Invoices
              {"\n"}12 files · 1 folder · nothing written yet
            </p>
            <p>
              <span className="who">assistant</span>
              {"\n"}One folder with 12 invoices. The originals stay where they are. Copy?
            </p>
            <p>
              <span className="you">you</span>
              {"\n"}Yes.
            </p>
            <p>
              <span className="who">crossdrive · copy</span>
              {"\n"}
              <span className="ok">done · 12 copied · 0 failed · audited</span>
            </p>
          </div>
        </div>
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Do you need this?</h2>
        <p>
          Perhaps not. As of mid-November 2026 there are user reports (one Reddit thread) that Claude&apos;s built-in
          Gmail and Drive connectors are gaining support for several accounts in a gradual rollout. We could not
          confirm this from Anthropic&apos;s documentation or test it ourselves. If you have it, and you only need to
          read and draft across a few Google accounts inside Claude, use it: it needs no setup.
        </p>
        <p style={{ margin: 0 }}>Crossdrive is for when you want:</p>
        <ul style={{ margin: 0 }}>
          {NEED.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </section>

      <section>
        <h2>What it does</h2>
        <div className="grid">
          {WHAT.map((f) => (
            <div className="card" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Safety is in the code</h2>
        <p className="muted">
          These rules are enforced by the server, not by a prompt. An assistant that misreads a request still cannot
          get past them.
        </p>
        <div className="grid">
          {SAFETY.map((f) => (
            <div className="card" key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>Your instance, your keys</h2>
        <ul>
          <li>You deploy it to your own Vercel account.</li>
          <li>It signs in to Google with your own Google Cloud project and OAuth client.</li>
          <li>Refresh tokens are encrypted at rest (AES-256-GCM) in storage you own.</li>
          <li>No third-party service sits between your assistant and your files. The code is MIT licensed.</li>
        </ul>
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Connect an assistant</h2>
        <p className="muted">
          First connect your cloud accounts on the connect page: sign in there to manage this instance, then connect each
          account under a label. Signing in alone connects nothing.
        </p>
        <p className="muted">
          Then add this URL as a custom connector (remote MCP server) in your client. It will ask you to sign in and
          approve access.
        </p>
        <pre className="endpoint" aria-label="MCP endpoint URL" title="Click to select">
          <code>{endpoint}</code>
        </pre>
        <div className="row">
          <Link href="/connect" className="btn">
            Connect cloud accounts
          </Link>
          <span className="muted" style={{ fontSize: "0.875rem" }}>
            Streamable HTTP · OAuth 2.1
          </span>
        </div>
      </section>
    </div>
  );
}
