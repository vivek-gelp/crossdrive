import Link from "next/link";
import { baseUrl } from "@/lib/config";

export const dynamic = "force-dynamic";

const GITHUB = "https://github.com/vivek-gelp/crossdrive";

const WHAT = [
  {
    title: "Every account, one connection",
    body: "Connect several Google accounts and give each a label. Your assistant addresses files as work:/Finance/2026 or personal:/Taxes and searches across all of them at once.",
  },
  {
    title: "Across clouds (BETA)",
    body: "Move and copy files and whole folders between accounts, and between Google Drive, OneDrive and Dropbox, without downloading anything to your laptop. OneDrive and Dropbox support is beta and not yet tested against live accounts.",
  },
  {
    title: "Gmail, draft-only by default",
    body: "Search and read mail in each connected Gmail account, save attachments to the right folder, and prepare replies. Sending stays off until you turn it on per account.",
  },
  {
    title: "Works from your phone",
    body: "It is a remote MCP server: one URL works in Claude, ChatGPT and any MCP client, on desktop, web and the mobile apps.",
  },
];

const SAFETY = [
  {
    title: "Trash only",
    body: "There is no permanent-delete call in the code. Deleting means moving to the provider's trash, where you can restore it.",
  },
  {
    title: "Read-only accounts",
    body: "Mark any account read-only and the server rejects every write to it, whatever the assistant asks for.",
  },
  {
    title: "Dry run, then undo",
    body: "Most writes can be previewed with a dry run first. Moves, renames and trashes are logged with an id that undo can roll back.",
  },
  {
    title: "Audit log",
    body: "Each write is recorded with time, client, account, action and file ids. File contents and mail bodies are not logged.",
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
          Claude&apos;s Drive connector sees one Google account. Crossdrive sees all of them, plus OneDrive and Dropbox
          in beta, through a single URL you host yourself.
        </p>
        <div className="row" style={{ marginTop: 24 }}>
          <Link href="/setup" className="btn btn-primary">
            Set up this instance
          </Link>
          <a href={GITHUB} className="btn" rel="noopener">
            View on GitHub
          </a>
        </div>

        <div className="demo" role="img" aria-label="Example: an assistant previews and then applies a move of 12 invoices between two drives">
          <div className="demo-bar">
            <i style={{ background: "var(--teal)" }} />
            <i style={{ background: "var(--amber)" }} />
            <span style={{ marginLeft: 8 }}>assistant · crossdrive</span>
          </div>
          <div className="demo-body">
            <p>
              <span className="you">you</span>
              {"\n"}Move last year&apos;s invoices from my personal drive to the company drive.
            </p>
            <p>
              <span className="who">crossdrive · batch move · dry run</span>
              {"\n"}from personal:/Invoices/2025
              {"\n"}to{"   "}work:/Finance/Invoices/2025
              {"\n"}12 files · 48 MB · 0 conflicts
            </p>
            <p>
              <span className="who">assistant</span>
              {"\n"}12 invoices, 48 MB, no name clashes. Nothing is deleted. Apply?
            </p>
            <p>
              <span className="you">you</span>
              {"\n"}Yes.
            </p>
            <p>
              <span className="who">crossdrive · batch move</span>
              {"\n"}
              <span className="ok">applied · 12 moved · undo id a1f3</span>
            </p>
          </div>
        </div>
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
