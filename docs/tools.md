# Tool reference

Crossdrive registers 44 tools on one MCP endpoint (`/api/mcp`). Read-only tokens (`CROSSDRIVE_READONLY_TOKENS`, or a
client downgraded to read-only on the consent screen) see the read tools only; accounts set to read-only refuse every
write tool in code. `dryRun` is accepted by `mkdir`, `put`, `move`, `rename`, `trash`, `untrash`, `copy`, `share`,
`unshare`, `batch` (default true), `undo`, `mail_label` and `transfer` (default true). The other write tools have no dry
run: `upload_begin`/`upload_finish`, `transfer_ownership`, `shortcut`, `mail_draft` (it only creates a draft),
`mail_send`, `mail_reply` and the beta `cloud_mkdir`, `cloud_move`, `cloud_rename` and `cloud_trash`.

The Drive, Gmail and sharing tools work on Google accounts only; given a OneDrive or Dropbox label they return an error
that points to the `cloud_*` tools and `transfer`.

## Addressing

- `label:/Folder/Sub` walks My Drive from the root of the account called `label`.
- Tools that take an `account` argument (`list`, `tree`, `mkdir`, `put`, `move`, ...) need it even when the path names
  the label: `list {account: "personal", path: "/Folder"}` or `path: "personal:/Folder"` (the label in the path must
  then match `account`). `find` (optional `account`) also scopes itself to the label named in its `path`.
- `label:~shared/Top Folder/Sub` starts at a folder shared with that account (matched by exact name).
- `label:drive/Shared Drive Name/Sub` starts at a Shared Drive (see `drives`).
- Files can also be addressed by `fileId`.
- Labels match `^[a-z][a-z0-9-]{0,23}$`. Names are folder and file names only.

Every Drive result carries `path`, `owner` (an email, `me`, or `unknown` when Drive withholds the owner of an item
shared with the account), `shared` (owned by someone else) and `canEdit`. Shared Drive items count as `me`. File and
mail content in results is wrapped and labelled as untrusted data. `mkdir`, `put`, `move`, `rename`, `trash` and `untrash`
return the `auditId` of their audit entry (the id `undo` takes).

## Accounts and health

| Tool | Access | Description |
|---|---|---|
| `accounts` | read | Connected accounts: label, provider, email, storage used and quota (Google), Gmail granted, mode (read-only or write), mail mode. OneDrive and Dropbox accounts are listed with a note instead of storage |
| `status` | read | Per account: whether a live token refresh works (or its error), granted scopes, provider, mode, mail mode, connection age; plus configuration warnings. `temporaryGrants` lists temporary copy grants Crossdrive created that Drive still shows (normally none) |
| `drives` | read | Shared Drives an account belongs to, each with its `label:drive/<name>` path. A consumer (gmail.com) account returns an empty list with a note |

## Finding and browsing

| Tool | Access | Description |
|---|---|---|
| `find` | read | Name and full-text search across all Google accounts or one, 20 s timeout per account. Each page is sorted newest first; Drive returns full-text matches in relevance order, so a later page can hold newer items than an earlier one. Paging with `pageToken` never returns an item twice. Returns per-account errors and `partial: true` if any account failed or timed out. OneDrive and Dropbox accounts are skipped and listed under `skipped` (use `cloud_find`). Options include `includeShared`, `foldersOnly` and scoping by `path` or `folderId` |
| `list` | read | One level of a folder; works for shared folders and Shared Drives; `label:~shared` lists everything shared |
| `tree` | read | A folder tree to a given depth with counts, sizes and dates |
| `shared` | read | Items other people shared with the account, newest first |
| `read` | read | File content as text: Docs, Sheets and Slides exported; PDF, docx, xlsx and text extracted. An xlsx returns its first sheet (or `sheet`) and lists all sheet names in `sheets`. A scanned PDF without a text layer returns `content: null` with a note. Paged with `offset` and `maxChars` |
| `inbox` | read | Loose files in the root of each drive plus the configured inbox folder |
| `permissions` | read | Who has access to a file: email, role, type, pending owner, expiry. A temporary copy grant that has not been removed is marked `temporary: true`. Without `fileId` (or with `leftovers: true`), the temporary copy grants on that account that Drive still shows, each checked against Drive, with how to remove it |
| `duplicates` | read | Duplicate groups by hash or name and size, within one account (optionally under `path` or `folderId`), sorted by wasted bytes, with a suggested keeper. With `acrossAccounts`: the same md5 and size in two or more accounts. `accounts` picks the accounts, and `path`/`paths` (`label:/folder`) or `account` + `folderId` limit an account to one folder tree. Groups come `limit` at a time (default 25) with `page.totalGroups`, `page.hasMore` and `page.cursor`. `minSize` drops small files |
| `changes` | read | Files modified since `24h`, `7d` or a date, across accounts, newest first |
| `audit` | read | Recent write-log entries, newest first (last 60 days, or one `date`); `batchId` groups the entries of one batch |

## Writing files

| Tool | Access | Description |
|---|---|---|
| `mkdir` | write | Create a folder; idempotent |
| `put` | write | Upload small text or base64 content, or stream an https `sourceUrl` into Drive server-side (200 MB cap). Without `mimeType` the type comes from the file extension (`sourceUrl`: the server's Content-Type). Defaults to the inbox folder, which is created at the root of My Drive when missing |
| `upload_begin` | write | Validates the name and access and returns a pre-authorised Drive resumable-upload URL; the client sends the bytes straight to Google |
| `upload_finish` | write | Fetches the finished file's metadata and writes the audit entry |
| `move` | write | Move a file or folder within one account |
| `rename` | write | Rename a file or folder |
| `trash`, `untrash` | write | Move to or restore from trash. Trash is the only delete |
| `undo` | write | Reverse a move, rename, trash or untrash recorded in the audit log (by entry `id` or `batchId`); refuses copies, uploads, sharing and mail |
| `copy` | write | Copy a file or a whole folder tree, within or across accounts. Folder copies are breadth-first and sliced; pass the returned `resume` cursor back until `done` is true. Existing items with the same name and size are skipped. Across Google accounts with a writable source: a temporary `reader` grant on one file at a time (4-hour expiry, removed right after, audited; `method: "share"`). With a read-only source, or a file only writers may copy: streamed through the server, with nothing written to the source (`method: "stream"`; Docs/Sheets/Slides are converted by export/import, Forms and other types without an import are listed in `notCopied`). The dry run reports the method per file. `trashOriginal` makes a cross-account move (refused for a read-only source). See [security.md](security.md#cross-account-copies-google-to-google) |
| `batch` | write | Up to 100 `move`, `rename`, `trash`, `copy` and `mkdir` operations. `dryRun` (default) previews with mutation counts; executing runs sequentially with per-item status and one `batchId` |

## Sharing

| Tool | Access | Description |
|---|---|---|
| `share` | write | Give reader, commenter or writer access to an email; no notification unless `notify` is set |
| `unshare` | write | Remove one person's permission |
| `transfer_ownership` | write | Direct inside a Workspace domain; otherwise creates a pending-owner invitation that the recipient must accept |
| `shortcut` | write | Create a Drive shortcut to a file or folder |

## Gmail

All mail tools take an explicit `account`; the sender is never inferred. The account's mail mode (`off`, `draft`, `send`)
decides which of them work.

| Tool | Access | Description |
|---|---|---|
| `mail_search` | read | Gmail search syntax (`from:`, `subject:`, `has:attachment`, `is:unread`, `newer_than:7d`); threads newest first; paged |
| `mail_read` | read (write with `saveAttachmentsTo`) | One message or a whole thread; bodies as plain text, never raw HTML; attachment metadata. `saveAttachmentsTo` (full access only) saves attachments to Drive; a read-only token that sends it gets an error and nothing is saved. Advertised with `readOnlyHint` only to read-only tokens |
| `mail_attachment` | read (write with `saveTo`) | One attachment, selected by `messageId` plus `partId`, `index` or `filename`: text for PDF, docx, xlsx, csv and txt, or saved to Drive with `saveTo` (full access only; refused with an error on a read-only token). Advertised with `readOnlyHint` only to read-only tokens |
| `mail_labels` | read | All labels with ids and unread counts |
| `mail_draft` | write | Create a draft; nothing is sent. Supports reply threading and Drive attachments (20 MB total) |
| `mail_send` | write | Send a draft or a new message. Requires mail mode `send` and, if configured, an allowed recipient |
| `mail_reply` | write | Reply to the newest message of a thread. Same requirements as `mail_send` |
| `mail_label` | write | Add or remove labels, archive, trash (the `TRASH` label), mark read or unread. No permanent delete |

## Other providers (beta)

**BETA.** OneDrive (Microsoft Graph) and Dropbox accounts use the same labels. These tools have not yet been tested
against live Microsoft or Dropbox accounts; they are tested against in-memory fakes of the APIs only. See
[providers.md](providers.md) for setup and caveats. The `cloud_*` tools also work on Google accounts.

| Tool | Access | Description |
|---|---|---|
| `transfer` | write | Copy or move a file or folder tree between any two accounts, across providers. `dryRun` defaults to true. Resumable with a `cursor`, verified by size and hash where comparable; with `move`, the source is trashed only after every item verified. Google to Google follows the same two methods as `copy`: per-file reader grants for a writable source, streaming for a read-only one |
| `cloud_list` | read | One page of a folder (`label:/path`, `pageToken`) on any provider |
| `cloud_find` | read | Name search (content too where the provider supports it) on one account or all, optionally below a folder |
| `cloud_read` | read | Plain-text files only, up to 2 MB |
| `cloud_mkdir` | write | Create `label:/A/B/New`, creating missing parents; idempotent |
| `cloud_move` | write | Move within one account; never overwrites |
| `cloud_rename` | write | Rename in place; never overwrites |
| `cloud_trash` | write | Move to the provider's recoverable trash (Drive trash, OneDrive recycle bin, Dropbox deleted files) |

## Conventions

- Errors come back as tool results with `isError` and a plain message, never as silent empty results.
- Large results are capped; follow the paging cursor or `resume` token returned.
- Google rate-limit responses are retried with backoff before an error is reported.
- With `CROSSDRIVE_NAMING_RULE=date-entity`, uploads and renames must match `YYYY-MM-DD_Company_WhatItIs.ext` unless
  `allowNonStandardName` is set (Google-native types are exempt). By default no naming rule applies.
