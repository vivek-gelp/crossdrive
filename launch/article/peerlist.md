<!--
PEERLIST  (Project page, then a Launchpad launch note / post)

Project fields:
  Project name:   Crossdrive
  Tagline:        Every drive you own. One safe connection for your AI.
  Project URL:    https://vivek-gelp.github.io/crossdrive/
  Source code:    https://github.com/vivek-gelp/crossdrive
  Categories:     Developer Tools, Open Source, AI   (pick the closest offered; up to 3)
  Tech stack:     TypeScript, Next.js, Vercel, Model Context Protocol, Google Drive API, Gmail API
  Cover/logo:     https://vivek-gelp.github.io/crossdrive/brand/social-card.png  (cover, 1280x640)
                  https://vivek-gelp.github.io/crossdrive/brand/crossdrive-mark-512.png  (logo, 512x512)
  Status:         Live, version 1.0.1, MIT licence
  Article link:   https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html
                  (Peerlist has no canonical field; link the article rather than pasting it)

Paste the two blocks BELOW the "-----8<-----" line into the description field and the launch note respectively.
-->
-----8<-----
## Project description

Crossdrive is a free, MIT-licensed, self-hosted MCP server: a guarded file-and-mail layer between an AI client and your Google Drive and Gmail accounts. Each account gets a label you choose, so files are addressed as `work:/Projects/2026`. Rules are enforced by the server per account: read-only or not, mail off, draft or send; trash is the only delete, writes can be dry-run and undone, and every write is audited. Files and folder trees copy and move between accounts, and search runs across every account and names any that failed. Only the Claude desktop app has been verified as a client. You deploy it to your own Vercel project with your own Google OAuth client. OneDrive and Dropbox support is beta and not yet tested on live accounts.

## Launch note

I built Crossdrive for my own problem: five Google accounts across several companies, and no way to tell an AI which of them it could change or send mail from. Before telling anyone, I tested it over four rounds on real accounts. It broke three ways (a consent screen Chrome could not approve, a temporary edit grant on a read-only copy source, a mistyped argument that put a folder in the wrong place), and all three are fixed in 1.0.1.

It is not for everyone. There are user reports, which I could not confirm, that Claude's built-in connectors are gaining several accounts; if you have that and only need to read and draft, it is less work. If you need Docs, Sheets or Calendar, a broader server fits better. I wrote up four ways to use several Google accounts with an AI assistant, including ones that need no new software: https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html

If you try it and get stuck, open an issue and I will help.
