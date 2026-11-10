# CLAUDE.md

Guide for people and AI agents working on Crossdrive. User-facing documentation is in `README.md` and `docs/`.

Crossdrive is a self-hosted remote MCP server (Streamable HTTP) that exposes several Google Drive and Gmail accounts,
and in beta OneDrive and Dropbox accounts, under user-chosen labels. Stack: Next.js (app router), TypeScript (strict),
`mcp-handler`, `jose`, `@vercel/blob`, raw Drive v3 and Gmail v1 REST over `fetch`, pnpm 10, Node 24. Deployed on Vercel.
The MCP endpoint is `/api/mcp`; admin pages are `/connect` and `/setup`; `/health` reports status without secrets.

## Commands

```bash
pnpm install
pnpm test                               # vitest; must stay green
pnpm typecheck                          # tsc --noEmit
pnpm lint                               # eslint
pnpm build                              # next build
pnpm dev                                # http://localhost:3000 (in-memory store without BLOB_READ_WRITE_TOKEN)
node scripts/check-pdf.mjs [file.pdf]   # PDF extraction under plain Node, outside Vitest
```

CI runs install (frozen lockfile), typecheck, lint, test and build with dummy environment variables. Run the same four
before opening a pull request.

## Architecture

| Path | Role |
|---|---|
| `app/api/mcp/route.ts` | MCP endpoint; bearer verification; full vs read-only tool set chosen by the token's scope (account modes are enforced per tool) |
| `app/oauth/*`, `app/.well-known/*` | Stateless OAuth 2.1 authorization server: dynamic client registration, PKCE S256, metadata, consent |
| `app/connect/*`, `app/api/google/callback` | Admin pages; account consent (Google, and beta Microsoft/Dropbox under `app/connect/{microsoft,dropbox}`); encrypted refresh tokens stored with granted scopes |
| `app/setup`, `app/health` | Setup checklist and status JSON |
| `src/lib/config.ts` | `env("NAME")` reads `CROSSDRIVE_NAME`, falling back to `VAULT_NAME`; allow-list, label validation |
| `src/lib/tools.ts`, `src/lib/tools-mail.ts` | MCP tool registration for Drive and Gmail; `tools.ts` also registers the provider tools from `providers/register.ts`; handlers stay thin |
| `src/lib/ops.ts`, `batch.ts`, `permissions.ts`, `copytree.ts`, `upload.ts`, `duplicates.ts`, `changes.ts` | Write and read logic shared by single tools and `batch` |
| `src/lib/drive.ts`, `gmail.ts`, `google.ts` | Google REST clients and OAuth helpers |
| `src/lib/mail.ts`, `mime.ts` | Mail composition, attachments, MIME building |
| `src/lib/crypto.ts`, `store.ts`, `audit.ts` | AES-256-GCM token storage in private Blob, append-only audit log |
| `src/lib/jwt.ts`, `oauth.ts` | HS256 JWT artefacts with a `use` claim; OAuth logic |
| `src/lib/paths.ts`, `naming.ts`, `readers.ts` | `label:/path` resolution, optional naming rule, PDF/docx/xlsx/text extraction |
| `src/lib/testing/` | Fakes of Drive and Gmail REST for handler-level tests, fixtures |
| `scripts/bulk-upload.mjs`, `scripts/lib/` | Local bulk uploader (Node 20+, no dependencies) and its tested helpers |
| `docs/` | Setup guides, security, tools reference, changelog, Google verification pack |

Provider code for OneDrive and Dropbox (BETA, not yet tested against live accounts) lives in `src/lib/providers/`; see
`docs/providers.md`. `providers/guards.ts` `assertGoogleAccount` keeps non-Google labels out of the Drive/Gmail tools
(called in `ctxFor` and `mailCtxFor`). Token checks and revocation for those providers are registered in `status.ts`
and `accounts.ts`.

## Invariants (do not break these)

1. **Trash is the only delete.** No tool may permanently delete a file or message, on any provider, and none may be
   added. `drive.ts` deliberately has no `files.delete`. `unshare` removes a permission, never a file.
2. **Gate in code, not prompts.** Read-only accounts, mail modes, the recipient allowlist and the naming rule are
   enforced by the server before any provider call. Never rely on tool annotations (`readOnlyHint`, `destructiveHint`)
   or on instructions in descriptions for safety; set annotations honestly but treat them as advisory.
3. **Every write is audited**, and the audit log never contains file contents, mail bodies or tokens. Mail entries carry
   recipients, subject, attachment names and ids.
4. **Dry runs.** Most write tools accept `dryRun` (the list is in `docs/tools.md`); give new write tools one. Writes
   call `assertWritable()` / `assertWriteMode()` before touching a provider.
5. **Content is untrusted data.** File and mail content is returned wrapped as data. The server never fetches URLs found
   inside documents. `mail_read` never returns raw HTML. No forwarding filters.
6. **Failures are loud.** Fan-out returns per-account errors and `partial`; unreachable Shared Drives raise explicit
   errors; never turn a failed precondition into success.
7. **Long work is sliced.** Folder copies return a `resume` cursor; uploads stream in chunks; large bodies go straight
   to the provider (`upload_begin`). A slice stops itself well before the route's `maxDuration`.
8. **Secrets by name only.** Never print, log, commit or paste secrets. `.env.local` is gitignored; do not `cat` it.
9. **Mail tools always take `account`**; the sender is never inferred.
10. **Labels** match `^[a-z][a-z0-9-]{0,23}$`. Nothing in the code may assume particular labels or companies.

## The PDF parser check

Vercel's Node runtime has no browser globals (`DOMMatrix`, `Path2D`, `ImageData`). pdf.js's default build needs them,
and Vitest does not expose the failure. PDFs go through `unpdf` (its serverless build). Any change that touches a parser
must also pass `node scripts/check-pdf.mjs` under plain Node. Never import pdf.js's default build directly. Heavy
parsers belong in `serverExternalPackages` in `next.config.ts`.

## Conventions

- TypeScript strict with `noUncheckedIndexedAccess`; `@/lib/...` imports from `app/`, relative imports inside `src/lib`.
- Tools use a zod `inputSchema` and a handler wrapped in `wrap()` so errors become `isError` text.
- Route handlers export `runtime = "nodejs"` and `dynamic = "force-dynamic"`.
- Tests sit beside the code as `*.test.ts`. Mock Drive with `fetchImpl` or `setDriveFetch()`, Gmail with
  `setMailFetch()` and the fakes in `src/lib/testing/`, OneDrive/Dropbox with `src/lib/providers/testing/`, the store
  with `setStore()`. No network in tests. Tests configure the legacy `VAULT_` names; `vitest.setup.ts` drops any
  `CROSSDRIVE_` variable from the environment so those take effect.
- Write the test first when changing behaviour.
- No new runtime dependencies without a reason.
- Use the `CROSSDRIVE_` prefix for new variables and keep the `VAULT_` fallback working.

## Pull request checklist

- Tests added or updated; `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass.
- Tool, env var or route changes are reflected in `README.md`, `docs/tools.md`, `.env.example` and `docs/CHANGELOG.md`.
- Version bumped in `src/lib/config.ts` and `package.json` together for a release.
- Redirect URI or scope changes are called out, because they need a matching edit in the Google Cloud console and a
  redeploy.
- Commit messages: imperative subject, a body that explains why.
