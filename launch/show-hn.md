# Show HN

## Title (under 80 characters)

Show HN: Crossdrive – per-account rules for AI access to Google Drive and Gmail

(79 characters. Alternative: "Show HN: Crossdrive – a guarded MCP layer for several Google accounts")

## URL

https://github.com/vivek-gelp/crossdrive

(Landing page, for the comment if asked: https://vivek-gelp.github.io/crossdrive/)

## First comment (post immediately after submitting)

I built this for my own five Google accounts across several companies. I wanted every request to name its account, and
the rules (which account is read-only, which may send mail) enforced somewhere the model cannot talk its way past. It
helped me, so I am sharing it in case it helps you.

A note first: there are user reports, which I could not confirm from Anthropic's documentation, that Claude's built-in
Gmail and Drive connectors are gaining support for several accounts. If you have that and only need to read and draft
inside Claude, use it; it needs no setup.

Crossdrive is a remote MCP server you deploy to your own Vercel project with your own Google OAuth client. Accounts get
labels (`work:/Projects/2026`). Per account: read-only or read + write, and mail off, draft or send. Trash is the only
delete, writes can be dry-run and undone, every write is audited, unknown arguments are refused. Between accounts:
copy and move of files and folder trees, duplicates across accounts, and `find` across all of them, naming any that
failed.

I tested it live over four rounds (two consumer Gmail accounts, one read-only Workspace account) first. It broke: the
consent screen could not be approved in Chrome, and a read-only copy source got a temporary writer grant. Both are
fixed in 1.0.1. Since then the Claude desktop app has connected to a live instance.

Not yet verified live: OneDrive and Dropbox (beta, fakes only), Claude Code, claude.ai on the web and ChatGPT as
clients, and disconnect-everything. Drive and Gmail only.

If you get stuck, open an issue and I will help. Criticism of docs/security.md is very welcome, and thank you in
advance. If it is not right for you, the README lists other options. MIT.
