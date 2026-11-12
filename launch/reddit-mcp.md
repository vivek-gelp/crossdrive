# r/mcp

Technical angle. Check the subreddit's self-promotion rules; disclose authorship.

## Title

Crossdrive 1.0.1: remote MCP server with stateless OAuth 2.1 + DCR, per-client consent and multi-account Google

## Body

I have been building a self-hosted remote MCP server for Google Drive and Gmail and wanted to share the parts that were
interesting from an MCP point of view, including what broke when I tested it on live accounts.

- **Auth:** a stateless authorization server on Next.js route handlers: dynamic client registration, PKCE S256, and every
  artefact (client registration, code, access and refresh token) is an HS256 JWT with a purpose claim. Codes are
  single-use (recorded with create-if-absent). Google refresh tokens are AES-256-GCM encrypted in a private Vercel Blob
  store.
- **Confused deputy:** one Google OAuth client serves several MCP clients, so the spec's per-client consent applies. The
  consent screen shows the requesting client and redirect host and can downgrade that client to read-only. In 1.0.0 it
  could not be approved in Chrome at all: `Referrer-Policy: no-referrer` made Chrome send `Origin: null` and the CSRF
  check refused it. The form is now bound to a short-lived cookie instead of relying on `Origin`.
- **Several accounts in one server:** tools take `label:/path`, so the model chooses the account per call. `find` fans
  out and returns per-account errors and `partial` rather than silently returning less.
- **Gating in code:** read-only accounts refuse write tools before any provider call, mail has off/draft/send modes plus
  an optional recipient allowlist, and no permanent delete tool exists. Annotations are set honestly but not relied on.
- **Strict arguments:** zod strips unknown keys by default and the SDK validates before your handler runs, so a
  misnamed argument used to vanish (in a live test `mkdir {path}` landed at the Drive root because the tool takes
  `parentPath`). Every input schema is now made strict at the one place tools are registered, with a "did you mean"
  hint in the error.
- **Untrusted content:** file and mail content is wrapped as data; the server never fetches URLs found in documents.
- **Long operations on serverless:** folder copy returns a resume cursor; large uploads use a pre-authorised Google
  resumable-upload URL so the bytes never pass through the function.

Tested live over four rounds with two consumer Gmail accounts and one Workspace account, through a scripted OAuth client
in Chrome. Not yet tested live: OneDrive and Dropbox (beta), the Claude and ChatGPT apps as clients, Docs/Sheets/Slides
conversion on the streamed copy path, and disconnect/reconnect. Drive and Gmail only; you bring your own Google Cloud
project.

Repo: https://github.com/vivek-gelp/crossdrive (MIT). Critique of the threat model in docs/security.md is especially
welcome.
