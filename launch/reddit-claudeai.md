# r/ClaudeAI

Check the subreddit rules and flair requirements first (self-promotion limits and project flair change over time). Post
as yourself, disclose that you are the author, and reply to every comment in the first hours.

## Title

The built-in Drive connector sees one Google account, so I made an open-source MCP server for several

## Body

The built-in Drive connector sees one Google account. I have five, across several companies, so I built Crossdrive
(1.0.1) to solve my own problem, and I am sharing it in case it helps you.

- One URL onto several Google Drive and Gmail accounts, each under a label you choose (`work:/Contracts`).
- Search all accounts at once, copy files and folder trees between them.
- Gmail: search, read, label, drafts. Sending is off by default.
- Trash is the only delete. Every write is logged; moves, renames and trashes can be undone.

I tested it over four live rounds (two consumer Gmail accounts, one read-only Workspace account) with a scripted OAuth
client. That found real bugs, including a consent screen that could not be approved in Chrome and a read-only
account getting a temporary writer grant as a copy source. Both are fixed. I have not yet run it from the Claude apps or
Claude Code; it should work as a custom connector; if not, please tell me.

Caveats: you deploy it yourself on Vercel with your own Google OAuth client, which is real setup work. Drive and
Gmail only; OneDrive and Dropbox are beta and untested live. If it is not right for you, the README lists other servers.

If you get stuck, open an issue or discussion and I will help. Thank you to those who reported this gap publicly, and
to anyone who tries it.

https://github.com/vivek-gelp/crossdrive

Disclosure: I am the author. MIT licensed, no paid tier.
