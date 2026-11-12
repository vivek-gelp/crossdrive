# X thread (6 posts)

1/ I have five Google accounts across several companies, and Claude's Drive connector sees one. I built Crossdrive to fix that for myself: one MCP URL for all of them, open source, self-hosted. I am sharing it in case it helps you too. https://github.com/vivek-gelp/crossdrive

2/ You label each account and address files as work:/Projects or personal:~shared/. Search covers every account and says which ones failed instead of quietly returning less. Folder trees copy between accounts with a resume cursor.

3/ Safety is in code, not the prompt. Trash is the only delete. Mail is draft-only by default. Any account can be read-only, and a read-only account is never modified, even as a copy source. Writes are logged, never contents.

4/ I tested it live over four rounds on two Gmail accounts and one Workspace account before sharing. It broke: the consent screen could not be approved in Chrome, and a read-only copy source got a temporary writer grant. Both are fixed in 1.0.1.

5/ Not yet tested live: OneDrive and Dropbox (beta), the Claude and ChatGPT apps themselves (I used a scripted OAuth client), and disconnect/reconnect. Drive and Gmail only; you create your own Google Cloud OAuth client.

6/ MIT licence. Thank you to everyone who documented this gap publicly, and to anyone who tries it. If setup loses you, tell me where and I will help; critique of the threat model is welcome. If it is not right for you, the README lists other servers. https://vivek-gelp.github.io/crossdrive/
