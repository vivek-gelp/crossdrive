# r/mcp

Technical angle. Check the subreddit's self-promotion rules; disclose authorship.

## Title

Crossdrive 1.0.1: remote MCP server with stateless OAuth 2.1 + DCR, per-client consent and multi-account Google

## Body

I built a self-hosted remote MCP server for Google Drive and Gmail (I am the author). These parts may help anyone
building a remote server, including what broke on live accounts.

- **Auth:** stateless authorization server on Next.js route handlers: dynamic client registration, PKCE S256, and every
  artefact is an HS256 JWT with a purpose claim. Codes are single-use. Refresh tokens are AES-256-GCM encrypted in a
  private Vercel Blob store.
- **Confused deputy:** per-client consent. In 1.0.0 the form could not be approved in Chrome: `Referrer-Policy:
  no-referrer` made Chrome send `Origin: null` and my CSRF check refused it. It is now bound to a short-lived cookie.
- **Several accounts:** tools take `label:/path`. `find` returns per-account errors and `partial` rather than silently
  returning less.
- **Gating in code:** read-only accounts refuse write tools before any provider call; mail has off/draft/send modes and
  an optional recipient allowlist; no permanent delete tool exists.
- **Strict arguments:** zod strips unknown keys, so in a live test `mkdir {path}` landed at the Drive root (the tool
  takes `parentPath`). Schemas are now strict, with a "did you mean" hint.
- **Serverless:** folder copy returns a resume cursor.

Tested live over four rounds (two consumer Gmail accounts, one Workspace) with a scripted OAuth client. Not yet tested
live: OneDrive and Dropbox (beta), the Claude and ChatGPT apps as clients, Docs/Sheets/Slides conversion on the streamed
copy path, disconnect/reconnect.

https://github.com/vivek-gelp/crossdrive (MIT). I would be grateful for critique of docs/security.md, and if you get
stuck, I will help.
