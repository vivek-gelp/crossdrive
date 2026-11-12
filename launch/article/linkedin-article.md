<!--
LINKEDIN ARTICLE  (Write article, from the start-a-post box)
About 700 words. LinkedIn articles have no canonical field, so the last line links the canonical page.

Fields:
  Title:         Using several Google accounts with Claude: four ways to do it
  Cover image:   https://vivek-gelp.github.io/crossdrive/brand/social-card.png  (download, then upload; 1280x640)
  Canonical:     none available on LinkedIn; keep the closing "first published at" line:
                 https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html
  Tags:          LinkedIn articles have no tag field. If you share it with a post, add at most three hashtags,
                 for example #AI #OpenSource #GoogleWorkspace

Paste the text BELOW the "-----8<-----" line. Make the four option names subheadings in LinkedIn's editor.
-->
-----8<-----
I have five Google accounts across several companies. When I started asking Claude to help with my files, it could see one of them at a time. This is what I learned, written for anyone in the same position, whether or not you use the tool I ended up building.

Why it is hard

As of November 2026, the most-reacted open request on Claude's connector tracker asks to attach two connectors with the same URL for different Google accounts: 44 reactions, 24 comments, no staff reply since April 2026 (github.com/anthropics/claude-ai-mcp/issues/178). Failures are often silent too: an open issue with 22 thumbs-up reports that Shared Drive searches come back empty instead of failing (github.com/anthropics/claude-code/issues/53442). And Google itself does not allow Drive ownership to move to or from a user outside your organisation (support.google.com/a/answer/1247799). Several accounts is not a missing button; it is how the identity model is built.

Four ways to do it

1. One connector, switch accounts by hand. Disconnect and reconnect as the other account when you need it. No setup, nothing to host. Right if you have one main account and only occasionally need another. You give up search and copying across accounts, and the model will not know it looked in the wrong place.

2. Share folders into one "hub" account. No new software, and sharing as Viewer gives read-only access folder by folder. Right when the folders are few and stable. What breaks: ownership stays with the original account, "Shared with me" is a view rather than storage, Shared Drives are where the silent empty results show up, and Gmail does not share like a folder at all.

3. A broader community server. taylorwilsdon/google_workspace_mcp has more than 120 tools across twelve Google products, including Docs, Sheets and Calendar. If you need more than Drive and Gmail, look there first. Multi-account is its documented weak spot: in OAuth 2.1 mode one session is bound to one Google identity, and a pull request for a per-account client was closed unmerged in November 2026, a reasonable call for auth code many people depend on.

4. Crossdrive, which I built. A self-hosted MCP server that gives an AI client one URL onto several Google Drive and Gmail accounts, each under a label you choose. It searches every account at once, names any account that failed, and copies folders between accounts. Trash is the only delete, mail is draft-only by default, any account can be read-only, every write is audited. The real costs: your own Google Cloud OAuth client, self-hosting on Vercel, Google's "unverified app" notice for personal Gmail accounts, Drive and Gmail only, and OneDrive and Dropbox still beta and untested on live accounts.

What to insist on from any tool

Agents have already bulk-deleted mail while ignoring "stop", and wiped a drive past the Recycle Bin. A rule in a prompt can be lost; a rule in code cannot. Whatever you choose, ask for trash-only delete, read-only access where possible, drafts rather than sends, a log you can read, errors that say which account failed, and your own OAuth client so your tokens stay with you.

What testing taught me

Before telling anyone, I tested Crossdrive over four rounds on real accounts. It broke three ways: the consent screen could not be approved in Chrome; a read-only account received a temporary edit grant when used as a copy source; and a mistyped argument put a folder in the wrong place. All three are fixed in 1.0.1. None would have shown up in a demo. If you build these tools, test against real accounts in a real browser, make the server refuse what it does not understand, and say plainly what you have not tested.

Thank you

Thank you to everyone who documented this problem in public issue trackers, and to the maintainers of the tools Crossdrive builds on. If you try it and get stuck, open an issue and I will help. If it is not right for you, I hope one of the other options is.

Code: https://github.com/vivek-gelp/crossdrive

First published, with every source linked, at https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html
