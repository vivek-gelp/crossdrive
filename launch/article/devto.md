<!--
DEV.TO  (dev.to/new, Markdown editor)
Paste everything BELOW the "-----8<-----" line into the editor, front matter included. It stays a draft
(published: false) until you switch it on and press Publish yourself.

Fields (already in the front matter): title:         Several Google accounts with an AI assistant: the built-in options, and when you still need more tags:          mcp, ai, googledrive, opensource   (dev.to allows at most 4) canonical_url: https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html cover_image:   https://vivek-gelp.github.io/crossdrive/brand/social-card.png

Before publishing: open the preview, check the cover image loaded, and confirm the canonical URL shows "Originally published at vivek-gelp.github.io" at the foot of the post. Reply to comments for the first day. -->
-----8<-----
---
title: "Several Google accounts with an AI assistant: the built-in options, and when you still need more"
published: false
description: "What Claude's built-in connectors do with several Google accounts (including an unconfirmed multi-account rollout), four honest options, and what to insist on from any tool that touches your files and mail."
tags: mcp, ai, googledrive, opensource
canonical_url: https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html
cover_image: https://vivek-gelp.github.io/crossdrive/brand/social-card.png
---

> **Updated 13 November 2026.** When I first published this on 12 November, its premise was that Claude's built-in connectors see one Google account each. Since then there are user reports (one Reddit thread, with a settings screenshot) that the built-in Gmail and Drive connectors are gaining support for several accounts in a gradual rollout, with per-tool approval settings. I could not confirm this from Anthropic's documentation, which on 12 November still described one connected account, and I have not been able to test it myself. If you have it, and you only need to read and draft across a few Google accounts inside Claude, use it: it needs no setup. I have revised option 1 below and narrowed what I say Crossdrive is for.

I have five Google accounts across several companies. When I started asking Claude to help with my files, I found it could see one of them at a time. This is what I learned trying to fix that, written for anyone in the same position, whether or not you ever use the tool I ended up building.

## Why it has been hard

Three facts, checked as of 12 November 2026.

**The connectors were documented as one account each.** The most-reacted open request on Claude's connector tracker asks to attach two connectors with the same URL for different Google accounts. It had 44 reactions and 24 comments, with no staff reply since April 2026 ([anthropics/claude-ai-mcp #178](https://github.com/anthropics/claude-ai-mcp/issues/178)). That request is about custom connectors, and it is still open; the reported change above is about the built-in ones.

**Failures are often silent.** An open issue reports that the Drive connector leaves out the flags Google needs for Shared Drives, so a search there comes back empty instead of failing. It has 22 thumbs-up and more than 20 reports. One reporter's main request was a clear error, because an empty answer leads to wrong conclusions ([anthropics/claude-code #53442](https://github.com/anthropics/claude-code/issues/53442)).

**Google keeps organisations apart on purpose.** Drive file ownership cannot be transferred to or from a user outside your organisation, such as a personal Google account or a user in another organisation ([Google Workspace Admin Help](https://support.google.com/a/answer/1247799?hl=en)).

So "several accounts" has never been just a missing button. Even when a connector can hold several accounts, there are further questions: which account a request runs in, which accounts may change or send anything, and whether anything can move between them.

## Four ways to do it

### 1. The built-in connector

If the reported multi-account support has reached you, connect each Google account to the built-in Gmail or Drive connector and you are done. It costs nothing, needs no setup, and someone else hosts and maintains it. Users who have it suggest starting read-only and being careful about which account mail is sent from, which seems wise with any tool.

If it has not reached you, the older way still works: disconnect the connector and reconnect it as the other account when you need it.

This is the right choice if you mostly read and draft inside Claude. What I do not know, because I have not been able to test it: whether one request can search across accounts, whether files can be copied or moved between accounts, and whether approval settings can differ per account. With the reconnect method you give up all of these, and you have to remember which account is connected.

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

This is what I built. [Crossdrive](https://github.com/vivek-gelp/crossdrive) is a guarded file-and-mail layer you host yourself, as a remote MCP server. Each account gets a label you choose, so a request always names its account, as in `work:/Projects/2026`. The rules are enforced by the server, per account: read-only or read + write, and mail off, draft or send. Trash is the only delete, writes can be dry-run and undone, every write is audited, and unknown arguments are refused. Between accounts, `copy` copies folder trees resumably, `transfer` moves files and trashes the source only after verifying the copy, `duplicates` finds the same file in several accounts, and `find` searches every account at once and names any account that failed. It is plain MCP, and your tokens stay in your own storage.

The real costs:

- **Your own Google Cloud OAuth client**, with the Drive and Gmail APIs enabled.
- **Self-hosting on Vercel**: a deploy, a Blob store and two secrets you generate.
- **Google's unverified-app notice.** For personal Gmail accounts you will see "Google hasn't verified this app" once per account. You must publish the consent screen to Production, or Google expires the refresh tokens after 7 days. Workspace accounts can use an Internal consent screen and see no warning.
- **Drive and Gmail only** on Google. No Docs editing, Sheets formulas or Calendar.
- **OneDrive and Dropbox are beta**, tested against in-memory fakes of their APIs and never against live accounts.
- **Limited client testing.** Live tests used a scripted OAuth client in Chrome plus one check with the Claude desktop app. Other clients are untested.

It is the right choice if you want rules per account that the server enforces, operations between accounts, or the same accounts from more than one AI client, and you are comfortable running a small deployment. If you only want to read and draft inside Claude, option 1 is less work.

## What to insist on, whichever you choose

Agents with file and mail access have already done real damage. In February 2026 an agent told only to suggest email deletions started bulk-deleting, ignored repeated messages to stop, and stopped only when its process was killed; its owner traced it to the instruction being lost when the context was compacted ([Simon Willison](https://simonwillison.net/2026/feb/23/summer-yue)). A coding agent wiped a drive with a command flag that bypasses the Recycle Bin ([TechRadar](https://www.techradar.com/ai-platforms-assistants/googles-antigravity-ai-deleted-a-developers-drive-and-then-apologized)), and another treated a failed `mkdir` as success and moved files into a folder that did not exist ([Ars Technica](https://arstechnica.com/information-technology/2025/07/ai-coding-assistants-chase-phantoms-destroy-real-user-data)). A rule written in a prompt can be lost. A rule written in code cannot. So, from any tool:

- **Trash-only delete.** Mistakes become recoverable. Google says the full Gmail scope is needed only to delete permanently, so a tool that never asks for it cannot do it ([Google](https://support.google.com/cloud/answer/13463817?hl=en)).
- **Read-only where possible**, per account and enforced by the server. It also limits what an instruction hidden in a document can do.
- **Drafts, not sends,** and a clear answer to "which account will this be sent from". Mail the model reads can carry hidden instructions; a draft waits for you ([the "lethal trifecta"](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/)).
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

Thank you to the people who documented this problem in public issue trackers. Your write-ups showed me I was not alone, and they shaped every safety rule above. If the built-in connectors now handle several accounts, I am glad, and I hope your requests helped. Thank you to the maintainers of the tools Crossdrive builds on: the Model Context Protocol TypeScript SDK, mcp-handler, Next.js, jose, zod and the PDF and Office parsers. And thank you to the google_workspace_mcp maintainer, whose explanations of the multi-account limits taught me a great deal.

If you try Crossdrive and get stuck, [open an issue](https://github.com/vivek-gelp/crossdrive/issues) and I will help. If it is not right for you, I hope one of the other options above is.

- Code and README: <https://github.com/vivek-gelp/crossdrive>
- Google setup: <https://github.com/vivek-gelp/crossdrive/blob/main/docs/setup-google.md>
- Security model: <https://github.com/vivek-gelp/crossdrive/blob/main/docs/security.md>
- Project site: <https://vivek-gelp.github.io/crossdrive/>
