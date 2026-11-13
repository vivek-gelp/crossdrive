# Changelog

## Unreleased

- Docs: the "Do you need this?" section in the README and on the landing page now opens with when you need
  Crossdrive (your assistant has no multi-account option yet, or you want more than three accounts) instead of
  "Perhaps not".
- Docs: repositioned the README, landing page and launch texts. The old headline ("Claude's Drive connector sees one
  Google account. Crossdrive sees all of them") is gone, because as of mid-November 2026 there are user reports
  (unconfirmed by Anthropic's documentation) that the built-in Gmail and Drive connectors are gaining several accounts.
  Crossdrive is now described by what holds either way: every account under a label, rules per account enforced on the
  server, operations between accounts, and no tie to one AI vendor. A "Do you need this?" section says when the
  built-in connector is the simpler choice, and the comparison table is re-dated with unknowns marked as not known.
- The logo is now served as `/favicon.ico` (16-256 px), PNG and apple-touch icons with `<link>` tags and a web manifest, as MCP `serverInfo.icons` (with `title`, `description` and `websiteUrl`), and the OAuth metadata links the privacy policy and terms.

## 1.0.1 (2026-11-12)

**Upgrade if you run 1.0.0.** Two problems in 1.0.0 matter to every user:

- **The consent screen could not be approved in Chrome** (and probably other Chromium browsers). Approve always ended
  on "Consent must be given from this site.", so no OAuth client could connect; only static bearer tokens worked.
- **A read-only account used as the source of a cross-account copy received a temporary writer grant.** `copy` and
  `transfer` between two Google accounts gave the destination account *writer* access to the source file, or to the
  whole source folder, even when the source account was set to read-only.

Both are fixed in 1.0.1, and the fixes were observed on live Google accounts. No environment variable or redirect URI
changes are required.

### Security

- **Read-only copy sources are never modified.** Before, the writer grant changed the item's `modifiedTime`, a folder
  stayed shared as writer until the copy finished (or for good if the client stopped following the resume cursor), a
  failed removal was ignored, and the grant for a single file was not audited. Now:
  - A read-only source is streamed through the server (download as the source, chunked resumable upload as the
    destination), files and folder trees alike, with the same resume cursor. No permission is created on it.
  - Google Docs/Sheets/Slides from a read-only source are exported to docx/xlsx/pptx and imported back as native files,
    flagged "converted (export/import): comments, revision history and some formatting are not preserved". Forms and
    other types without an import path, and shortcuts, are listed in `notCopied` with the reason. The dry run predicts
    all of this.
  - A writable source grants `reader` (never writer) on one file at a time and removes it in a `finally` path. Folders
    are never shared. A file with `copyRequiresWriterPermission` is streamed instead. A removal that fails is reported
    loudly with the permission id and the `unshare` call that removes it.
  - An expiry is set on that grant only where Google allows it (Google Workspace). Consumer Gmail accounts refuse one,
    so there the protection is the immediate removal plus the leftover listing in `status`; the dry run says "expiry:
    only if the account allows it". (Earlier 1.0.1 builds promised a 4-hour expiry in every case.)
  - Every temporary grant and removal is audited (`temp_grant`, `temp_grant_removed`, `temp_grant_remove_failed`).
  - `status` and `permissions` list leftover grants after checking them against Drive.
  - A folder copy resumed with a cursor from an earlier 1.0.1 build removes the old folder-wide writer share first.
  - `trashOriginal` / `move: true` from a read-only source, and any copy or transfer into a read-only account, are
    refused, dry runs included.
- **Unknown tool arguments are rejected instead of ignored.** In 1.0.0 an argument a tool did not know was dropped
  silently; in a live test `mkdir {path: ...}` (it takes `parentPath`) created the folder at the My Drive root. Every
  tool, including batch items and nested objects such as `saveTo`, now refuses an unknown argument before anything runs,
  names it, lists the accepted ones and suggests the likely intended one ("did you mean parentPath?").
- **Write destinations are explicit.** `mkdir` needs `parentPath` or `parentId`, `move` (also in `batch`) needs `toPath`
  or `toFolderId`, and `upload_begin` needs `path` or `folderId`. Before, `mkdir` defaulted to the My Drive root and
  `move` to the inbox folder. `put` keeps its documented default, the inbox folder.
- **Consent screen.** The page sent `Referrer-Policy: no-referrer`, which makes Chrome send `Origin: null` on the form
  POST, and the server refused that. The page now uses `strict-origin`, and the approval no longer depends on the
  `Origin` header alone: showing the page sets a short-lived, HttpOnly, SameSite=Lax cookie that the signed consent
  token is bound to, and Approve needs both. A request from another site is still refused, and each consent screen can
  be answered only once. Approve in the same browser that showed the screen, with cookies enabled for the site.
- The connect page's form check had the same weakness (`Origin: null` refused); it now relies on its session-bound
  token in that case and still refuses other sites.
- **Read-only mode, mail mode and disconnects apply at once.** In 1.0.0 each server instance cached the account list
  for up to 60 seconds, so a write could still go through on an account that had just been switched to read-only (seen
  in a live test: a folder was created). Every write now reads the account's mode fresh.
- Authorization codes can be redeemed only once; a second redemption gets `invalid_grant`. Refresh tokens are
  unchanged (not rotated), so one client can still refresh from several processes at once.
- Every route sends `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` and `Permissions-Policy`
  headers.
- Patched transitive dependencies: postcss, zod, minimatch.

### Fixed

- `audit` took about 55 seconds on a young log (a client could time out); it now lists the days that have entries once
  instead of probing all 60 days one by one, and stops once it has enough entries. Old per-day log files are still read.
- `duplicates` with `acrossAccounts` could not be narrowed: it ignored `path` and `folderId`, sorted groups largest
  first, and was cut at the 60,000-character result limit, so small duplicates never appeared. Now `path`/`paths`
  (`label:/folder`) or `account` + `folderId` limit an account to one folder tree, and `accounts` picks the accounts.
  Groups come `limit` at a time (default 25) with `page.totalGroups`, `page.hasMore` and a `page.cursor`, so nothing is
  cut silently. Accounts are scanned in parallel, at most four at a time.
- `put` with `contentBase64` and no `mimeType` stored PDFs and Office files as `text/plain`; the type now comes from the
  file extension. `put` also returns its `auditId`.
- `find` no longer returns an item twice across pages, and each page is sorted newest first.
- `drives` on a consumer Gmail account returns the promised note with its empty list.
- Items whose owner Drive does not reveal were reported as yours (`owner: "me"`, `shared: false`); only
  `ownedByMe: true` or an owner entry matching the account now counts as "me", Shared Drive items show
  `shared drive "<name>"` as owner, and anything from "Shared with me" is always `shared: true`.
- A read-only client that asks `mail_read` / `mail_attachment` to save to Drive gets a clear error instead of having the
  request silently ignored.
- `transfer` with `dryRun` refuses a read-only destination (or a read-only source with `move: true`) exactly like the
  real run, instead of reporting no issues.
- `transfer` results list the destination path of each created file in `created[]`, not the source path.
- After a move, rename or trash, the server instance that made it drops its cached paths for that account, so its next
  results show the new paths. Other instances can still show an old path for up to five minutes.
- An invalid or expired bearer token gets "Invalid or expired access token" instead of "No authorization provided".
- Pressing Back after answering the consent screen shows "This request was already answered" (HTTP 409) instead of
  sending the client a `server_error`.
- The consent screen is styled (the page's security policy had blocked the site stylesheet).
- `/connect` no longer tells you to open `/connect` when no account is connected.
- `read` on an xlsx lists the workbook's sheet names.
- The display font is bundled with the repo; builds no longer fetch Google Fonts (a redeploy failed on that).

### Changed

- `copy` results have `method` (`same`, `share` or `stream`). Streamed copies return the transfer engine's counters
  (`copied`, `converted`, `notCopied`, `resume`).
- `/connect` separates signing in from connecting: the add-account form comes first, a progress line shows the three
  steps, a notice says when the signed-in e-mail is not connected yet (with a one-click connect), and each connection
  or failed consent ends on a banner naming the e-mail, label and access, or the reason.
- `CROSSDRIVE_BASE_URL` is optional on Vercel: when it is unset, Crossdrive uses Vercel's production domain
  (`VERCEL_PROJECT_PRODUCTION_URL`), so the first deploy no longer needs a second deploy to set it. An explicit value
  still wins; set it for a custom domain. `/setup`, `/health` and the `status` tool show the Vercel value as passing, and
  the "host differs" warning shows the current value and says it must be the deployment's own address, not the GitHub
  repository URL. The Deploy button no longer asks for it.
- `/setup` checks the shape of `GOOGLE_CLIENT_ID` (must end in `.apps.googleusercontent.com`) and
  `GOOGLE_CLIENT_SECRET` (not empty, no whitespace, no placeholder text such as `PASTE_CLIENT_ID`), without printing
  either value. A secret without the `GOCSPX-` prefix is marked "check", not "fail". `/connect` and the sign-in routes
  show a configuration error pointing to `/setup` instead of sending you to Google's "Error 401: invalid_client".

### Docs

- README: a "What has been tested" section (four live rounds on 12 November 2026), the list of what has not been
  verified live, and the limits found in those rounds.
- The temporary-grant expiry is described as it behaves: set only where Google allows it.
- The audit log stores mail recipients, subjects and attachment names; tools that take `account` need it even with a
  labelled path; connecting several Google accounts needs each signed in to the browser; `shared` means "owned by
  someone else", not "has collaborators"; argument names differ between tools, and unknown ones are rejected.
- Setup docs updated for the base-URL and client-id checks (README, setup-vercel, setup-google troubleshooting for
  `invalid_client`, `.env.example`).

## 1.0.0 - Crossdrive (2026-11-10)

The project is renamed from "Vault MCP" to **Crossdrive** and released under the MIT licence. This version generalises
the single-owner build into software anyone can deploy.

Breaking or notable for existing deployments:

- Environment variables use the `CROSSDRIVE_` prefix. The old `VAULT_` prefix is still accepted for every variable
  (`CROSSDRIVE_` wins when both are set). `GOOGLE_*`, `BLOB_READ_WRITE_TOKEN` and the new provider variables are
  unprefixed. Stored accounts, the audit log, the admin cookie and the OAuth scope strings (`vault`, `vault:read`) are
  unchanged, so issued tokens and sessions keep working after the upgrade.
- `scripts/bulk-upload.mjs` has no default server URL: pass `--url` or set `CROSSDRIVE_URL`; the token is
  `CROSSDRIVE_TOKEN` (`VAULT_URL` / `VAULT_TOKEN` still accepted).
- The MCP server reports its name as `crossdrive`; `/health` reports `service: "crossdrive"`.
- Account labels are no longer fixed. Any number of accounts can be connected under labels you choose
  (`^[a-z][a-z0-9-]{0,23}$`).
- The naming rule is now opt-in: set `CROSSDRIVE_NAMING_RULE=date-entity` to enforce `YYYY-MM-DD_Company_WhatItIs.ext`.
  The default is off.
- The inbox folder is configurable (`CROSSDRIVE_INBOX_FOLDER`).
- New accounts default to mail mode `draft`.

Added:

- Connect page: per-account mode (read-only or write) and mail mode (off, draft, send), reconnect, disconnect with
  Google token revocation, and a "disconnect everything" kill switch that works from a phone.
- Per-client consent screen showing the requesting client and its redirect host, with the option to downgrade the client
  to read-only.
- `/setup` checklist page.
- Tools: `status`, `tree`, `undo`; `duplicates` works across accounts.
- `find` returns per-account errors and `partial` instead of failing silently, with timeouts and paging; Shared Drives
  that cannot be reached return an explicit error.
- Retry with backoff on Google rate limits; response-size guard on every tool.
- `dryRun` on most write tools (see docs/tools.md for the ones without it).
- File and mail content returned wrapped as untrusted data.
- Optional recipient allowlist for sending mail (`CROSSDRIVE_MAIL_ALLOWED_RECIPIENTS`).
- BETA: OneDrive and Dropbox accounts, the `transfer` tool and the `cloud_*` tools, connected on `/connect` with redirect
  URIs `<BASE_URL>/connect/microsoft/callback` and `<BASE_URL>/connect/dropbox/callback`. Not yet tested against live
  Microsoft or Dropbox accounts. Google-only tools refuse these accounts with a pointer to the `cloud_*` tools; `find`
  skips them; `status` checks their tokens; disconnect revokes Dropbox grants (Microsoft has no per-token revoke).
- Open-source project files: licence, contributing guide, security policy, code of conduct, CI workflow, issue and pull
  request templates, Dependabot configuration, setup guides and a Google verification pack.

Unchanged: no permanent delete, no forwarding filters, no fetching of URLs found inside documents.

## 0.5.2 — PDF extraction on Vercel (2026-11-10)

- **PDF text extraction works in production.** Every `read` of a PDF and every `mail_attachment` in text mode failed on
  Vercel with `DOMMatrix is not defined` since 0.1.0: pdf.js's default build (via `pdf-parse`) expects browser globals
  that Vercel's Node runtime does not have, and Vitest never exposed it. PDFs now go through `unpdf`, whose
  serverless pdf.js build needs none of them (`pdf-parse` removed; `unpdf` added to `serverExternalPackages`).
  Pages are joined by a blank line; `offset`/`maxChars` pagination is unchanged.
- **Scanned PDFs** (no text layer) no longer come back as empty text: `read` answers `content: null` with
  `No extractable text: this PDF has no text layer ...`, `mail_attachment` the same note plus the hint to `saveTo`.
- `scripts/check-pdf.mjs` runs the reader under plain `node` (no Vitest) against the fixtures or any PDF you pass, and
  prints whether `DOMMatrix`/`Path2D` exist in that runtime; use it whenever a parser changes.

Internals: `readers.ts` (`pdfText`, `NoTextError`, `NO_TEXT_LAYER`), fixtures `src/lib/testing/fixtures/{sample,scanned}.pdf`,
the Gmail fake serves binary attachments as latin1. 199 → 202 tests.

## 0.5.1 — fixes from the first live run (2026-11-10)

- **Cross-account folder copy no longer loses files to Drive's share propagation delay.** A writer share on the top
  folder reaches the children asynchronously, so the destination answered `404` for most files. `copy` now waits until
  the destination can read the first child (backoff 0.5/1/2/4/8 s), retries a file that answers 404/429/5xx three
  times with backoff, then shares that one file directly (writer, no e-mail), copies it and removes the share again.
  Anything still failing transiently stays in the `resume` cursor and is listed under `retrying`; `done` stays `false`
  (the temporary share stays too) for up to three resumes, after which the item is reported in `failures`. Permanent
  errors (e.g. 403) are reported at once as before.
- **`mail_attachment` no longer trusts `attachmentId`.** Gmail hands out a different id on every `messages.get`, so an
  id taken from `mail_read` moments earlier could already be stale. The tool re-fetches the message and selects the
  attachment by `partId`, `index` or `filename` (new optional arguments; `attachmentId` is optional and only a fallback,
  which still works for messages with a single attachment), then downloads with the fresh id. `mail_read` returns
  `partId` and `index` per attachment; `saveAttachmentsTo` always used ids from its own fetch.

Internals: `copytree.ts` (`waitForVisibility`, `copyOne`, `retry` in the cursor, `isTransient`), `mail.ts`
`AttachmentSelector`; the Drive fake can delay inherited permissions (`inheritDelay`) and choose the copy failure
status, the Gmail fake can hand out volatile attachment ids. 195 → 199 tests.

## 0.5.0 — folder copy, attachments, large uploads (2026-11-10)

Three new tools (33 in total) and three extended ones. Still no permanent delete; every write is audit-logged.

- **`copy` copies folders.** Breadth-first: subfolders re-created, files copied server-side, shortcuts re-created
  pointing at the same target, names preserved. Works in slices of `maxFiles` (default 150) items per call and returns
  `{copiedFiles, createdFolders, shortcuts, skipped, failures[], totals, done, resume}`; pass `resume` back until
  `done=true`. Cross-account copies share the top source folder with the destination account once (writer, no
  e-mail; Drive inherits it) and remove the share when done. Items already present at the destination with the same
  name and size are skipped, so a cut-off slice can simply be repeated. `dryRun=true` walks the tree (cap 5000) and
  returns files/folders/bytes and the number of calls. `trashOriginal` trashes only the top folder, only once done.
  Copying a folder into itself is refused; `batch` still copies single files only.
- **`mail_attachment`** `{account, messageId, attachmentId}` downloads one attachment (`messages.attachments.get`) and
  returns its text through the `read` readers (PDF/docx/xlsx/csv/txt), or metadata plus a note for images and other
  binaries. With `saveTo {account, path|folderId, name?, allowNonStandardName?}` the bytes become a Drive file
  (multipart up to 5 MB, resumable above), audit-logged with message id and size. **`mail_read`** gains
  `saveAttachmentsTo {account, path|folderId, prefix?}` that saves every attachment of the message or thread
  (`prefix_filename` keeps the naming rule satisfiable) and lists the created files with per-item errors. Read-only
  tokens get both tools without the saving fields.
- **Large uploads.** `upload_begin {account, path|folderId, name, mimeType, size}` validates the name and write access,
  opens a Drive resumable upload session with the account's token and returns the pre-authorised `uploadUrl`
  (`expiresInSeconds` about a week, `chunkBytes` 8 MiB, instructions); the client PUTs the bytes straight to Google
  with `Content-Range` headers and no credentials. `upload_finish {account, fileId}` fetches the metadata and audits
  the file (`upload_begin` audits the announced name/size). `put` accepts `sourceUrl` (https only, 200 MB cap): the
  server streams the URL into a resumable session in 256 KiB-aligned chunks. The MCP route now runs with
  `maxDuration = 300` (Fluid compute); a folder-copy slice stops itself after 240 s.
- **`scripts/bulk-upload.mjs`**: local bulk uploader (Node 20+, no dependencies) that mirrors a folder with `mkdir`,
  skips files already present with the same name and size, uploads via `upload_begin` + chunked PUT (retry/resume on
  308) + `upload_finish`, prints progress and writes a manifest CSV; `--dry-run`, `--concurrency`, `--include`,
  `--exclude`, `--allow-nonstandard-names`. Auth via `VAULT_URL` and `VAULT_TOKEN`.

Internals: `copytree.ts`, `upload.ts`, `scripts/lib/bulk.mjs`; `FILE_FIELDS` includes `shortcutDetails`; audit entries
gain `counts`/`done` (folder copies), `size`/`sourceUrl` (uploads) and `note`; the Drive fake learns permission
inheritance, upload sessions and external URLs, the Gmail fake serves attachment bytes. 162 → 195 tests.

## 0.4.0 — Gmail (2026-11-09)

Seven mail tools (30 in total) on the same Google OAuth client and account labels; read-only tokens get the three
read tools. Nothing permanently deletes mail.

- **Scopes.** Consent now asks for `drive`, `gmail.modify`, `gmail.compose` and `gmail.send` with
  `include_granted_scopes=true`; the granted set (parsed from the token response) is stored per account. Records from
  before 0.4.0 load as `scopes=["drive"]`. `/connect` shows a Gmail column and a **Grant Gmail access** button that
  re-runs consent for that account (`login_hint`, `prompt=consent`); `accounts` and `/health` report `gmail` per label.
  Mail tools answer `Gmail not granted for <label>; open /connect and grant Gmail access` until then.
- `mail_search` — Gmail query syntax, threads newest first with the newest message's id/from/to/subject/date/snippet,
  labels, unread, hasAttachments; paged.
- `mail_read` — a message or a whole thread: headers, plain-text body (HTML rendered to text), attachment metadata.
- `mail_labels` / `mail_label` — list labels; add/remove labels on a message or thread (archive = remove INBOX, trash =
  TRASH label, markRead).
- `mail_draft` — draft with text + HTML parts, optional reply threading (In-Reply-To/References/threadId) and Drive
  attachments downloaded through the owning account (Docs/Sheets/Slides exported to PDF, 20 MB total).
- `mail_send` — send a draft (`draftId`) or a new message; `account` is always explicit.
- `mail_reply` — reply to the newest message of a thread (Reply-To/From, reply-all minus self, `Re:` once).
- Every mail write is audit-logged with recipients, subject, attachment names and Gmail ids.

Internals: `gmail.ts` (REST client + parsers), `mail.ts` (context, scope gate, compose, reply, labels), `mime.ts`
(RFC 2822 builder, base64url, RFC 2047/2231, markdown-ish -> HTML, HTML -> text), `tools-mail.ts`, `toolkit.ts`
(shared `wrap`), `testing/fakeGmail.ts`. 111 → 162 tests. Each connected account must re-run consent once.

## 0.3.0 — reorganization toolkit (2026-11-09)

Ten new tools (23 in total), all audit-logged where they write. Still no permanent delete.

- `copy` — copy a file into a folder of the same or another connected account. Cross-account copies go through a
  temporary writer permission for the destination account and Drive's server-side `files.copy`; no bytes pass through
  the server. Google-native files keep their type. Folders are refused (no recursive copy yet). `trashOriginal` turns
  it into a cross-account move.
- `batch` — up to 100 `move`/`rename`/`trash`/`copy`/`mkdir` operations in one call. `dryRun=true` (default) previews
  every operation (resolved paths, current names, view-only check, destination exists) without changing anything;
  `dryRun=false` executes sequentially with per-item status and one shared `batchId` in the audit log.
- `permissions`, `share`, `unshare`, `transfer_ownership`, `shortcut` — list and change who has access, transfer
  ownership (direct inside a Workspace domain; pending-owner invitation for Gmail accounts and across domains),
  create Drive shortcuts.
- `duplicates` — read-only duplicate scan per account (md5, or name+size for Google-native files) with wasted bytes
  and a suggested copy to keep.
- `drives` — list an account's Shared Drives. New path form `label:drive/<Drive name>/Sub`; `list`, `find`, `mkdir`,
  `move`, `put`, `copy` work inside Shared Drives (`supportsAllDrives`/`includeItemsFromAllDrives` on every call).
- `changes` — files modified since `7d`/`24h`/a date across accounts, newest first.

Internals: `ctx.ts` (shared request context and result helpers), `ops.ts` (plan/apply write operations reused by
`batch`), `batch.ts`, `permissions.ts`, `duplicates.ts`, `changes.ts`; `testing/fakeDrive.ts` multi-account fake
for handler-level tests. 62 → 111 tests.

## 0.2.0 — shared-with-me support

`label:~shared/Top/Sub` paths, `shared` tool, `owner`/`shared`/`canEdit` on every result, view-only guard before
writes.

## 0.1.0

Initial release: remote MCP server over five Google Drives with OAuth 2.1, naming rule, inbox default, trash-only
delete and audit log.
