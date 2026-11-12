# r/ClaudeAI

Check the subreddit rules and flair requirements first (self-promotion limits and project flair change over time). Post
as yourself, disclose that you are the author, and reply to every comment in the first hours.

## Title

I built an open-source MCP server so Claude can work across several Google accounts (the built-in connector sees one)

## Body

If you have more than one Google account, you will have noticed the built-in Drive connector only sees one of them.
I have five, across several companies, so I built Crossdrive: one remote MCP server for all of them, version 1.0.1.

What it does:

- One URL onto several Google Drive and Gmail accounts, each under a label you choose (`work:/Contracts`).
- Search across every account at once, copy files and folder trees between accounts, find duplicates across accounts.
- Gmail: search, read, label, archive, drafts. Sending is off by default, and any account can be set to read-only.
- Trash is the only delete. Every write is logged, and moves, renames and trashes can be undone.

How it was tested, honestly: I ran four live rounds against two consumer Gmail accounts and one Workspace account (the
Workspace one read-only), using a scripted OAuth client in Chrome. Those rounds found real bugs, including a consent
screen that could not be approved in Chrome and a read-only account getting a temporary writer grant when used as a
copy source; both are fixed in 1.0.1. I have not yet run it from the Claude apps or Claude Code themselves. It should
work as a custom connector (Settings, Connectors, Add custom connector), but if it does not, I want to know.

Before you try it: you deploy it yourself on Vercel and create your own Google OAuth client. The docs go step by step,
but it is real setup work. It is Drive and Gmail only; OneDrive and Dropbox support is beta and untested on live
accounts.

Repo, with what has and has not been tested and a comparison to the other Google MCP servers:
https://github.com/vivek-gelp/crossdrive

Disclosure: I am the author. MIT licensed, no hosted service or paid tier. Questions and bug reports welcome.
