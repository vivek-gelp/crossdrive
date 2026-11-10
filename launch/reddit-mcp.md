# r/mcp

Technical angle. Check the subreddit's self-promotion rules; disclose authorship.

## Title

Crossdrive: a remote MCP server with stateless OAuth 2.1 + DCR + PKCE, per-client consent and multi-account Google

## Body

I have been building a self-hosted remote MCP server for Google Drive and Gmail and wanted to share the parts that were
interesting from an MCP point of view.

- **Auth:** a stateless authorization server on Next.js route handlers: dynamic client registration, PKCE S256, and every
  artefact (client registration, code, access and refresh token) is an HS256 JWT with a purpose claim. Google refresh
  tokens are the only state, AES-256-GCM encrypted in a private Vercel Blob store.
- **Confused deputy:** one Google OAuth client serves several MCP clients, so the spec's per-client consent applies. The
  consent screen shows the requesting client and redirect host and can downgrade that client to read-only.
- **Several accounts in one server:** tools take `label:/path`, so the model chooses the account per call. `find` fans
  out and returns per-account errors and `partial` rather than silently returning less.
- **Gating in code:** read-only accounts refuse write tools before any provider call, mail has off/draft/send modes plus
  an optional recipient allowlist, and no permanent delete tool exists. Annotations are set honestly but not relied on.
- **Untrusted content:** file and mail content is wrapped as data; the server never fetches URLs found in documents.
- **Long operations on serverless:** folder copy returns a resume cursor; large uploads use a pre-authorised Google
  resumable-upload URL so the bytes never pass through the function.

Honest limitations: Drive and Gmail only; you bring your own Google Cloud project; OneDrive and Dropbox support is beta
and not yet tested against live accounts by the maintainers.

Repo: https://github.com/vivek-gelp/crossdrive (MIT). Critique of the threat model in docs/security.md is especially
welcome.
