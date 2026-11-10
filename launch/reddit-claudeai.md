# r/ClaudeAI

Check the subreddit rules and flair requirements first (self-promotion limits and project flair change over time). Post
as yourself, disclose that you are the author, and reply to every comment in the first hours.

## Title

I made Claude able to see all my Google accounts at once (it only sees one by default)

## Body

If you have more than one Google account, you will have noticed the built-in Drive connector only sees one of them.
I have five, so I built an open-source MCP server that gives Claude one connector for all of them.

What it does in practice:

- Add it once as a custom connector (Settings, Connectors, Add custom connector). It then works in Claude on the web,
  desktop and the phone app, and in Claude Code.
- Ask things like "search all my drives for the 2026 lease", "move the signed contract from my work drive to my
  personal one" or "which files are duplicated across my accounts".
- Gmail: search, read, label, archive, draft replies. Sending is off by default and each account can be set to read-only.
- Trash is the only delete. Everything it writes is logged, and there is an undo for moves, renames and trashes.

What you need to know first: you deploy it yourself on Vercel and create your own Google OAuth client. I wrote
click-by-click docs, but expect 20 to 30 minutes the first time. It is Drive and Gmail only.

Repo, with the comparison to the built-in connector and the other Google MCP servers: https://github.com/vivek-gelp/crossdrive

Disclosure: I am the author. It is MIT licensed and there is no hosted service or paid tier. Questions and bug reports
welcome.
