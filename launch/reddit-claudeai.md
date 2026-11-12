# r/ClaudeAI

Check the subreddit rules and flair requirements first (self-promotion limits and project flair change over time). Post
as yourself, disclose that you are the author, and reply to every comment in the first hours.

## Title

I made an open-source MCP server that puts per-account rules on several Google Drive and Gmail accounts

## Body

I have five Google accounts across several companies, and I wanted Claude to work across them with rules I could rely
on: this account read-only, that one allowed to draft but never send. So I built Crossdrive (1.0.1) for myself, and I
am sharing it in case it helps you.

First, in fairness: there is a report here that the built-in Gmail and Drive connectors are gaining support for several
accounts. I have not been able to confirm that from Anthropic's documentation or test it. If you have it and only need
Claude to read and draft across a few accounts, use it; it needs no setup.

Crossdrive is for when you want more than that:

- Every account under a label you choose (`work:/Contracts`), so nothing happens "in whichever account".
- Rules per account, enforced on the server: read-only, mail off / draft / send, trash-only delete, dry run, undo, an
  audit log.
- Work between accounts: copy and move files and folder trees, find duplicates, one search that names any account that
  failed.
- Your own hosting: tokens stay in your Vercel storage, and it is plain MCP rather than tied to one app.

I tested it over four live rounds (two consumer Gmail accounts, one read-only Workspace account). That found real bugs,
including a consent screen that could not be approved in Chrome and a read-only account getting a temporary writer
grant as a copy source. Both are fixed. I have since connected it from the Claude desktop app against a live instance.
I have not yet tried claude.ai on the web, the mobile apps, ChatGPT or Claude Code; if it does not work there, please
tell me.

Caveats: you deploy it yourself on Vercel with your own Google OAuth client, which is real setup work. Drive and Gmail
only; OneDrive and Dropbox are beta and untested live.

If you get stuck, open an issue or discussion and I will help. Thank you to anyone who tries it.

https://github.com/vivek-gelp/crossdrive

Disclosure: I am the author. MIT licensed, no paid tier.
