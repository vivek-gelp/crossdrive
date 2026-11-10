# X thread (6 posts)

1/ I have five Google accounts across a few companies. Claude's Drive connector sees one of them. So I built Crossdrive: one MCP URL for all of them, open source, self-hosted. https://github.com/vivek-gelp/crossdrive

2/ You label each account yourself and address files as work:/Projects or personal:~shared/. Search fans out across every account and tells you which ones failed instead of quietly returning less.

3/ Cross-account copy of whole folder trees, resumable, using Drive's server-side copy. No file bytes pass through the server. Works from the Claude phone app once you have added the connector.

4/ Safety is in code, not the prompt. Trash is the only delete. Mail is draft-only by default. Any account can be read-only. Every write is logged (actions, never contents). A disconnect-everything button works from a phone.

5/ Honest caveats: Drive and Gmail only (use google_workspace_mcp for the rest of Workspace). You create your own Google Cloud OAuth client, and on personal Gmail you click through Google's unverified-app screen once. OneDrive and Dropbox support is beta and untested on live accounts.

6/ MIT licence, setup docs with the Google Cloud steps spelled out, and a threat model you can argue with. I would like to hear where the setup docs lose you. https://github.com/vivek-gelp/crossdrive
