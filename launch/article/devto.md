<!--
DEV.TO  (dev.to/new, Markdown editor)
Paste everything BELOW the "-----8<-----" line into the editor, front matter included. It stays a draft
(published: false) until you switch it on and press Publish yourself.

Fields (already in the front matter): title:         Using several Google accounts with Claude: why it is hard, and four ways to do it tags:          mcp, ai, googledrive, opensource   (dev.to allows at most 4) canonical_url: https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html cover_image:   https://vivek-gelp.github.io/crossdrive/brand/social-card.png

Before publishing: open the preview, check the cover image loaded, and confirm the canonical URL shows "Originally published at vivek-gelp.github.io" at the foot of the post. Reply to comments for the first day. -->
-----8<-----
---
title: "Using several Google accounts with Claude: why it is hard, and four ways to do it"
published: false
description: "Why Claude's connectors see one Google account each, four honest ways to work across several, and what to insist on from any tool that touches your files and mail."
tags: mcp, ai, googledrive, opensource
canonical_url: https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html
cover_image: https://vivek-gelp.github.io/crossdrive/brand/social-card.png
---

I have five Google accounts across several companies. When I started asking Claude to help with my files, I found it could see one of them at a time. This is what I learned trying to fix that, written for anyone in the same position, whether or not you ever use the tool I ended up building.

## Why it is hard

Three facts, all checked as of November 2026.

**The connectors are one account each.** The most-reacted open request on Claude's connector tracker asks to attach two connectors with the same URL for different Google accounts. It has 44 reactions and 24 comments, with no staff reply since April 2026 ([anthropics/claude-ai-mcp #178](https://github.com/anthropics/claude-ai-mcp/issues/178)).

**Failures are often silent.** An open issue reports that the Drive connector leaves out the flags Google needs for Shared Drives, so a search there comes back empty instead of failing. It has 22 thumbs-up and more than 20 reports. One reporter's main request was a clear error, because an empty answer leads to wrong conclusions ([anthropics/claude-code #53442](https://github.com/anthropics/claude-code/issues/53442)).

**Google keeps organisations apart on purpose.** Drive file ownership cannot be transferred to or from a user outside your organisation, such as a personal Google account or a user in another organisation ([Google Workspace Admin Help](https://support.google.com/a/answer/1247799?hl=en)).

So "several accounts" is not a missing button. It is a gap between one-identity connectors and an identity model that keeps accounts apart by design.

## Four ways to do it

### 1. One connector, and switch accounts by hand

Disconnect the connector and reconnect it as the other account when you need it. It costs nothing, needs no setup, and someone else hosts and maintains it.

This is the right choice if you have one main account and only occasionally need another, or if you mostly read. What you give up: no search across accounts, no copying between them, and you have to remember which account is connected. The connector will not tell the model it looked in the wrong place.

### 2. Share folders into one "hub" account

Share the folders you care about from each account into one account, and connect only that one. No new software, and sharing as Viewer gives read-only access folder by folder.

It is the right choice when the folders are few and stable. What breaks:

- **Ownership.** Files stay owned by the original account, and Google will not move ownership across organisations. What the hub sees under "Shared with me" is a view, not storage: if the owning account closes, those files go with it ([Google Drive Help](https://support.google.com/drive/answer/2375057?hl=en)).
- **Shared Drives.** Items reached through sharing and Shared Drives are where the silent empty results above show up.
- **Gmail.** Mail does not share like a folder. The hub sees only its own mail unless you set up forwarding or delegation in every account, and each of those is a security decision of its own.

### 3. A broader community Google Workspace MCP server

[taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) is the most complete community server I know of: more than 120 tools across twelve Google products, including Docs editing, Sheets and Calendar. If you need more than Drive and Gmail, look here first.

Multi-account is its documented weak spot, and the maintainer has explained why with care. In OAuth 2.1 mode one MCP session is bound to one Google identity, so an account parameter is ignored; in the older mode the model can read the wrong account and still report success ([#162](https://github.com/taylorwilsdon/google_workspace_mcp/issues/162)). A pull request adding a separate OAuth client per account was closed unmerged in November 2026 ([PR #1103](https://github.com/taylorwilsdon/google_workspace_mcp/pull/1103)), which is a reasonable call for auth code that many people depend on. Running one entry per account works in clients that allow it, but Claude's custom connectors allow one connector per URL.

### 4. Crossdrive

This is what I built. [Crossdrive](https://github.com/vivek-gelp/crossdrive) is a self-hosted remote MCP server that gives an AI client one URL onto several Google Drive and Gmail accounts. Each account gets a label you choose, so a path reads `work:/Projects/2026`. `find` searches every account at once and names any account that failed. `copy` copies folder trees between accounts, resumably. Trash is the only delete, mail is draft-only by default, any account can be read-only, and every write is audited.

The real costs:

- **Your own Google Cloud OAuth client**, with the Drive and Gmail APIs enabled.
- **Self-hosting on Vercel**: a deploy, a Blob store and two secrets you generate.
- **Google's unverified-app notice.** For personal Gmail accounts you will see "Google hasn't verified this app" once per account. You must publish the consent screen to Production, or Google expires the refresh tokens after 7 days. Workspace accounts can use an Internal consent screen and see no warning.
- **Drive and Gmail only** on Google. No Docs editing, Sheets formulas or Calendar.
- **OneDrive and Dropbox are beta**, tested against in-memory fakes of their APIs and never against live accounts.
- **Limited client testing.** Live tests used a scripted OAuth client in Chrome plus one check with the Claude desktop app. Other clients are untested.

It is the right choice if you have several accounts, want one conversation to work across them, and are comfortable running a small deployment.

## What to insist on, whichever you choose

Agents with file and mail access have already done real damage. In February 2026 an agent told only to suggest email deletions started bulk-deleting, ignored repeated messages to stop, and stopped only when its process was killed; its owner traced it to the instruction being lost when the context was compacted ([Simon Willison](https://simonwillison.net/2026/feb/23/summer-yue)). A coding agent wiped a drive with a command flag that bypasses the Recycle Bin ([TechRadar](https://www.techradar.com/ai-platforms-assistants/googles-antigravity-ai-deleted-a-developers-drive-and-then-apologized)), and another treated a failed `mkdir` as success and moved files into a folder that did not exist ([Ars Technica](https://arstechnica.com/information-technology/2025/07/ai-coding-assistants-chase-phantoms-destroy-real-user-data)). A rule written in a prompt can be lost. A rule written in code cannot. So, from any tool:

- **Trash-only delete.** Mistakes become recoverable. Google says the full Gmail scope is needed only to delete permanently, so a tool that never asks for it cannot do it ([Google](https://support.google.com/cloud/answer/13463817?hl=en)).
- **Read-only where possible**, per account and enforced by the server. It also limits what an instruction hidden in a document can do.
- **Drafts, not sends.** Mail the model reads can carry hidden instructions; a draft waits for you ([the "lethal trifecta"](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)).
- **A log you can read**: what changed, in which account, when.
- **Errors that say which account failed.** A silent empty result is how wrong conclusions start.
- **Your own OAuth client.** Your refresh tokens stay in your own project instead of with a third party.

## What a first real deployment taught me

Before telling anyone, I tested Crossdrive over four rounds on real accounts: two consumer Gmail accounts and one Workspace account in read-only mode, through the real consent screen in an unmodified Chrome. It broke in three ways that mattered.

- **The consent screen could not be approved in Chrome.** The page sent a no-referrer policy, so Chrome sent `Origin: null` on the Approve button, and the server refused it. No OAuth client could connect. The approval is now bound to a short-lived cookie set when the screen is shown, as well as a signed token.
- **A read-only account received a temporary edit grant as a copy source.** Copying out of it gave the destination writer access to the source file, or the whole folder. Read-only sources are now streamed through the server with no permission added; writable sources grant reader on one file at a time, removed straight away and audited.
- **A mistyped argument put a folder in the wrong place.** `mkdir` was given `path` instead of `parentPath`; the unknown argument was ignored and the folder landed at the My Drive root. Unknown arguments are now refused with a "did you mean" hint.

All three are fixed in [1.0.1](https://github.com/vivek-gelp/crossdrive/blob/main/docs/CHANGELOG.md). The lesson for anyone building these tools: none of this would have shown up in a demo. Test against real accounts in a real browser before you announce anything, make the server refuse what it does not understand, and publish what you have not tested as plainly as what you have.

## Thank you

Thank you to the people who documented this problem in public issue trackers. Your write-ups showed me I was not alone, and they shaped every safety rule above. Thank you to the maintainers of the tools Crossdrive builds on: the Model Context Protocol TypeScript SDK, mcp-handler, Next.js, jose, zod and the PDF and Office parsers. And thank you to the google_workspace_mcp maintainer, whose explanations of the multi-account limits taught me a great deal.

If you try Crossdrive and get stuck, [open an issue](https://github.com/vivek-gelp/crossdrive/issues) and I will help. If it is not right for you, I hope one of the other options above is.

- Code and README: <https://github.com/vivek-gelp/crossdrive>
- Google setup: <https://github.com/vivek-gelp/crossdrive/blob/main/docs/setup-google.md>
- Security model: <https://github.com/vivek-gelp/crossdrive/blob/main/docs/security.md>
- Project site: <https://vivek-gelp.github.io/crossdrive/>
