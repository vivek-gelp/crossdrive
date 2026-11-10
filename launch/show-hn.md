# Show HN

## Title (under 80 characters)

Show HN: Crossdrive – one MCP URL for all your Google Drive and Gmail accounts

(77 characters. Alternative: "Show HN: Self-hosted MCP server for several Google Drive/Gmail accounts")

## URL

https://github.com/vivek-gelp/crossdrive

## First comment (post immediately after submitting)

I run several small companies, which means five Google accounts: one personal Gmail and four company Workspace or
Gmail accounts. When I started using Claude to tidy files, I hit the same wall every time. The built-in Drive connector
sees one Google account, so the AI could organise one drive and be blind to the other four. Moving a contract from one
company's drive to another's meant downloading and re-uploading it by hand.

I looked at what exists. Claude's connector is one account per connector (there is an open request to attach two to the
same URL). Google's official Drive and Gmail MCP servers are a developer preview that needs programme enrolment, and
the Gmail one is draft-only. The most-used community server is excellent and covers twelve Google products, but
multi-account is a documented weak spot there. The things that actually went wrong for me were quieter: Shared Drive
files silently missing from results (a missing API flag that shows up in several servers), and no way to stop an agent
that had decided to be helpful.

So I built Crossdrive, a remote MCP server you deploy to your own Vercel project with your own Google OAuth client:

- You label each account yourself and address files as `work:/Projects/2026` or `personal:~shared/...`.
- `find` searches every account in parallel and tells you which accounts failed, instead of returning less.
- Folder trees can be copied between accounts using Drive's server-side copy; no file bytes pass through the server, and
  the copy is resumable.
- The safety rules are in code: trash is the only delete, mail is draft-only by default, each account can be read-only,
  every write is audited, and there is a "disconnect everything" button that works from a phone.
- Content from files and mail is returned as untrusted data and the server never fetches URLs found in documents.

Things I would want to know if I were reading this:

- It is Drive and Gmail only. If you want Docs, Sheets or Calendar tools, use google_workspace_mcp.
- You do have to create a Google Cloud project and OAuth client. The docs walk through it, but it is the part where most
  people struggle. On personal Gmail you will see Google's "unverified app" screen once for your own app.
- A hosted, Google-verified version is not offered: Drive and Gmail are restricted scopes and verification needs an
  annual third-party security assessment. Self-hosting is the answer for now.
- OneDrive and Dropbox support, including cross-provider transfer, is beta and has not been tested against live
  Microsoft or Dropbox accounts by me yet.

It is MIT licensed. I would most like feedback on the setup docs (where did you get stuck?) and on the threat model in
docs/security.md. Happy to answer questions.
