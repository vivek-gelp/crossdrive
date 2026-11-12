# X thread (6 posts)

1/ I have five Google accounts across several companies. Claude's Drive connector sees one of them. So I built Crossdrive: one MCP URL for all of them, open source, self-hosted. Version 1.0.1. https://github.com/vivek-gelp/crossdrive

2/ You label each account yourself and address files as work:/Projects or personal:~shared/. Search fans out across every account and tells you which ones failed instead of quietly returning less. Folder trees copy between accounts with a resume cursor.

3/ Safety is in code, not the prompt. Trash is the only delete. Mail is draft-only by default. Any account can be read-only, and a read-only account is never modified, even as the source of a copy. Every write is logged, never contents. Unknown tool arguments are rejected.

4/ Before announcing I tested it live over four rounds on two Gmail accounts and one Workspace account. It broke: the consent screen could not be approved in Chrome, and a read-only copy source got a temporary writer grant. Both fixed in 1.0.1.

5/ Not yet tested live: OneDrive and Dropbox (beta), the Claude and ChatGPT apps themselves (the tests used a scripted OAuth client), and disconnect/reconnect. Drive and Gmail only; you create your own Google Cloud OAuth client.

6/ MIT licence, setup docs with the Google Cloud steps spelled out, a list of what has and has not been tested, and a threat model you can argue with. Tell me where the setup docs lose you. https://vivek-gelp.github.io/crossdrive/
