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

Crossdrive is a free, MIT-licensed, self-hosted MCP server that gives an AI client one URL onto several Google Drive and Gmail accounts. Each account gets a label you choose, so files are addressed as `work:/Projects/2026`. Search runs across every account and names any account that failed; folders copy between accounts, resumably. Safety is enforced in code: trash is the only delete, mail is draft-only by default, any account can be read-only, and every write is audited. You deploy it to your own Vercel project with your own Google OAuth client. OneDrive and Dropbox support is beta and not yet tested on live accounts.

## Launch note

I built Crossdrive for my own problem: five Google accounts across several companies, and an AI connector that sees one. Before telling anyone, I tested it over four rounds on real accounts. It broke three ways (a consent screen Chrome could not approve, a temporary edit grant on a read-only copy source, a mistyped argument that put a folder in the wrong place), and all three are fixed in 1.0.1.

It is not for everyone. With one Google account the built-in connector is less work, and if you need Docs, Sheets or Calendar a broader server fits better. I wrote up four ways to use several Google accounts with Claude, including ones that need no new software: https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html

If you try it and get stuck, open an issue and I will help.
