# X thread (6 posts)

1/ I have five Google accounts. I wanted an AI to work across them under rules it cannot talk its way past: this one read-only, that one drafts but never sends. So I built Crossdrive, open source and self-hosted, and I am sharing it in case it helps. https://github.com/vivek-gelp/crossdrive

2/ In fairness: there are user reports that Claude's built-in Gmail and Drive connectors are gaining several accounts. I could not confirm it from Anthropic's docs. If you have it and only need to read and draft, use it; no setup.

3/ Crossdrive is for more than that. Every account sits under a label (work:/Projects), so nothing happens in "whichever account". Per account, on the server: read-only, mail off / draft / send. Trash is the only delete; dry run, undo, audit log; unknown arguments refused.

4/ Between accounts: copy and move files and folder trees, find duplicates, and one search that names any account that failed. It is plain MCP, and your tokens stay in your own Vercel storage.

5/ I tested it live over four rounds on two Gmail accounts and one Workspace account. It broke, and 1.0.1 fixes what broke. The Claude desktop app is the only client verified so far. OneDrive and Dropbox are beta, untested live. Drive and Gmail only.

6/ MIT licence. Thank you to anyone who tries it. If setup loses you, tell me where and I will help; critique of the threat model is welcome. https://vivek-gelp.github.io/crossdrive/
