# Crossdrive 1.0.1

**Upgrade if you run 1.0.0.** In 1.0.0 the consent screen could not be approved in Chrome, so no OAuth client could
connect, and a read-only account used as the source of a cross-account copy received a temporary writer grant. Both
are fixed. This release comes out of four rounds of live testing on 12 November 2026 against two consumer Gmail
accounts and one Google Workspace account (the Workspace one read-only); everything below that was broken in those
rounds was fixed and, unless noted, seen working on the live accounts afterwards. No environment variable or redirect
URI changes are required. Full details: [docs/CHANGELOG.md](https://github.com/vivek-gelp/crossdrive/blob/main/docs/CHANGELOG.md).

## Security

- **Read-only copy sources are never modified.** A read-only source is streamed through your deployment, files and
  folder trees alike, with no permission added. A writable source grants `reader` (never writer) on one file at a time,
  removed in a `finally` path and audited; folders are never shared; leftovers are listed by `status` and
  `permissions`. An expiry is set on that grant only where Google allows it (Google Workspace); consumer Gmail accounts
  refuse one, so there the protection is the immediate removal plus the leftover listing. Moving out of, or copying
  into, a read-only account is refused, dry runs included.
- **Unknown tool arguments are rejected instead of ignored**, with the accepted names and a "did you mean" hint; this
  covers batch items and nested objects. In 1.0.0, `mkdir {path: ...}` (it takes `parentPath`) created the folder at
  the My Drive root.
- **Write destinations are explicit.** `mkdir`, `move` (also in `batch`) and `upload_begin` need a destination; only
  `put` keeps its documented inbox-folder default.
- **Consent screen.** Approve works in Chrome; the form is bound to a short-lived cookie instead of the `Origin` header,
  other sites are still refused, and each screen can be answered once.
- **Read-only and mail-mode switches apply at once** (1.0.0 cached accounts for up to 60 seconds per instance; a test
  write went through in that window).
- Authorization codes are single-use. Security headers on every route. Patched postcss, zod and minimatch.

## Fixed

- `audit` took about 55 seconds on a young log.
- `duplicates` across accounts can be scoped to folders and paged, instead of being cut at the result limit.
- `put` stored PDFs and Office files as `text/plain`; it now infers the type and returns its `auditId`.
- `find` no longer repeats items across pages.
- `drives` on a consumer account returns its note; items with a hidden owner are no longer reported as yours.
- A read-only client asking to save an attachment gets a clear error.
- `transfer` dry runs refuse a read-only destination like the real run; `transfer` reports destination paths in
  `created[]`.
- After a move, rename or trash, the instance that made it refreshes its cached paths.
- Clearer messages for a bad bearer token and for Back after the consent screen; the consent screen is styled.
- `read` on an xlsx lists its sheet names. The display font is bundled, so builds no longer fetch Google Fonts.

## Changed

- `copy` results report `method` (`same`, `share` or `stream`).
- `/connect` separates signing in from connecting, puts the add-account form first and confirms each connection.
- `CROSSDRIVE_BASE_URL` is optional on Vercel; `/setup` checks the Google client id and secret for placeholders.

## Docs

- The README has a "What has been tested" section and the limits found in live testing.
- The temporary-grant expiry, the meaning of `shared`, the audit log's mail fields and the argument names are
  documented as they behave.

## Tested

Live, on 12 November 2026, with a scripted OAuth client through real Chrome:

- `/setup`, `/health`, client registration, the consent screen (full, read-only, deny), single-use codes, token refresh.
- Connecting three Google accounts under labels; switching mode and mail mode on `/connect` (in effect about one second
  later).
- Reading: `accounts`, `status`, `list`, `find` across three accounts with paging, `read` (Google Doc, PDF, xlsx,
  docx), `tree`, `changes`, `shared`, `drives`, `duplicates` within and across accounts, `audit`.
- Writing: `mkdir`, `put`, `rename`, `move`, `trash`, `untrash`, `undo`, `batch` (also across two accounts).
- Cross-account `copy` of files and folder trees with resume, and `transfer` copy and move with hash verification, by
  both methods (per-file reader grant from a writable source; streaming from read-only consumer and Workspace sources,
  with the source unchanged).
- Every write tool refused on a read-only account before Google was called, dry runs included.
- Gmail: search, read, labels, attachments (read and save to Drive), drafts, labelling, send and reply under the mail
  modes.

## Not yet tested

- OneDrive and Dropbox (beta; never run against live accounts).
- The Claude apps (web, desktop, mobile), Claude Code and ChatGPT as clients.
- Docs/Sheets/Slides conversion on the streamed copy path, and Forms/Drawings being skipped (automated tests only).
- Disconnect, reconnect and "Disconnect everything".
- The recipient allowlist (`CROSSDRIVE_MAIL_ALLOWED_RECIPIENTS`).
- The Deploy to Vercel button from an account other than the repository owner's.
- Sharing tools, large uploads (`upload_begin`, bulk upload, `put` with `sourceUrl`), Shared Drive contents and static
  bearer tokens, beyond their read-only refusals.
