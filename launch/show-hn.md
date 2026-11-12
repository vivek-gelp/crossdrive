# Show HN

## Title (under 80 characters)

Show HN: Crossdrive – one MCP URL for all your Google Drive and Gmail accounts

(78 characters. Alternative: "Show HN: Self-hosted MCP server for several Google Drive/Gmail accounts")

## URL

https://github.com/vivek-gelp/crossdrive

(Landing page, for the comment if asked: https://vivek-gelp.github.io/crossdrive/)

## First comment (post immediately after submitting)

I built this for my own problem: five Google accounts across several companies, and Claude's built-in Drive connector
sees one. It helped me, so I am sharing it in case it helps you. Thank you to the people who wrote up this same gap in
public issue trackers; it showed me I was not alone.

Crossdrive is a remote MCP server you deploy to your own Vercel project with your own Google OAuth client. Accounts
get labels (`work:/Projects/2026`), `find` searches all of them and names any that failed, and folders copy between them.
Safety is in code: trash is the only delete, mail is draft-only by default, any account can be read-only.

I tested it live over four rounds (two consumer Gmail accounts, one read-only Workspace account) first. It broke: the consent screen could not be approved in Chrome, and a read-only copy source got a temporary writer grant.
Both are fixed in 1.0.1.

Not yet verified live: OneDrive and Dropbox (beta, fakes only), the Claude, Claude Code and ChatGPT apps (my tests used
a scripted OAuth client), and disconnect-everything. Drive and Gmail only.

If you get stuck, open an issue and I will help. Criticism of docs/security.md is very welcome, and thank you in
advance. If it is not right for you, the README lists other servers. MIT.
