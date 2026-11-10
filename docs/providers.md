# OneDrive and Dropbox accounts, cross-cloud transfer (BETA)

Crossdrive can connect Microsoft OneDrive (personal and work/school, through Microsoft Graph) and Dropbox accounts next to
Google accounts, each under its own label. You can browse them and copy or move files and whole folder trees between any
two connected accounts, whatever the provider.

## What BETA means

- **Not yet tested against live accounts.** The OneDrive and Dropbox adapters follow the documented APIs (Graph v1.0 `driveItem`, upload sessions; Dropbox API v2,
  upload sessions). They are tested against in-memory fakes of those APIs, **not against live Microsoft or Dropbox
  accounts**. Try a dry run and a small folder first, and check the verification report.
- Moves never permanently delete anything. The source is trashed only after every item has been copied and verified:
  Google Drive trash, OneDrive recycle bin, or Dropbox deleted files. All three can be restored.
- Tool names and result shapes may still change.

## Register a Microsoft (Azure) app

1. Go to <https://entra.microsoft.com> → **App registrations** → **New registration**.
2. **Supported account types**: *Accounts in any organizational directory and personal Microsoft accounts*. This lets
   one app connect both personal OneDrive and work/school OneDrive. If you only want one tenant, choose single tenant and
   set `MS_TENANT` to that tenant id or domain.
3. **Redirect URI**: platform **Web**, `https://<your-deployment>/connect/microsoft/callback`. For local development also
   add `http://localhost:3000/connect/microsoft/callback`.
4. **Certificates & secrets** → **New client secret**. Copy the *value* (not the id) into `MS_CLIENT_SECRET`. Secrets
   expire, so note the date and rotate it before then.
5. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**: `Files.ReadWrite.All`,
   `User.Read`, `offline_access`. Some work/school tenants do not let users consent to `Files.ReadWrite.All`. In that
   case a tenant admin must click **Grant admin consent**.
6. Copy the **Application (client) ID** into `MS_CLIENT_ID`.

The connect flow asks for `offline_access Files.ReadWrite.All User.Read` with PKCE (S256) and `prompt=select_account`.
Microsoft rotates refresh tokens. The server saves a new one whenever Microsoft returns it.

## Register a Dropbox app

1. Go to <https://www.dropbox.com/developers/apps> → **Create app** → **Scoped access** → **Full Dropbox**.
   (*App folder* also works, but then only that folder is visible.)
2. **Permissions** tab: enable `account_info.read`, `files.metadata.read`, `files.content.read` and
   `files.content.write`, then **Submit**. The consent screen grants whatever is enabled here. The server does not
   request a scope list.
3. **Settings** tab → **OAuth 2 / Redirect URIs**: add `https://<your-deployment>/connect/dropbox/callback` (and the
   localhost variant for development).
4. Copy **App key** into `DROPBOX_CLIENT_ID` and **App secret** into `DROPBOX_CLIENT_SECRET`.

A Dropbox app in *development* status can be linked by a limited number of users. That is enough for a self-hosted
instance, so you do not need to apply for production.

## Environment variables

| Name | Required | Meaning |
|------|----------|---------|
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET` | for OneDrive | Azure app (client) id and secret value |
| `MS_TENANT` | no | `common` (default), `organizations`, `consumers`, or a tenant id/domain |
| `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET` | for Dropbox | Dropbox app key and secret |

`CROSSDRIVE_BASE_URL` (legacy `VAULT_BASE_URL`) must be the public origin, because the redirect URIs are built from
it. Redeploy after changing env vars. When a provider's client id is set, `/setup` lists its redirect URI.

## Connecting

Sign in at `/connect` as admin, type a label (and for Microsoft optionally the account's email) and click **Connect
Microsoft** or **Connect Dropbox**. The buttons only appear when the provider's client id is configured. The same
flows can be started directly:

- `/connect/microsoft/start?label=work` (optionally `&email=you@example.com`; `login_hint` is accepted as an alias)
- `/connect/dropbox/start?label=client-a`

Labels are lower-case, start with a letter, and are at most 24 characters (`^[a-z][a-z0-9-]{0,23}$`). A label already used
by another provider is refused, and an existing label is only replaced through the card's **Reconnect** button
(`&reconnect=1`), which keeps the account's mode. Accounts are stored encrypted like Google accounts, with `provider`
set, mode `write` for a new account and mail `off`.

`/connect` and the `status` tool check each OneDrive and Dropbox account by refreshing its token. **Disconnect** revokes
a Dropbox grant at Dropbox. Microsoft has no endpoint that revokes a single delegated refresh token, so disconnecting a
OneDrive account deletes the stored token and reports "revoke failed"; remove the app's consent yourself at
<https://account.live.com/consent/Manage> (personal) or <https://myapps.microsoft.com> (work/school).

The Google-only tools (`find`, `list`, `read`, `put`, `copy`, `mail_*`, ...) refuse a OneDrive or Dropbox label with a
pointer to the tools below; `find` across all accounts skips them and lists them under `skipped`; `accounts` lists them
with their provider.

## Tools

| Tool | Kind | What it does |
|------|------|--------------|
| `cloud_list` | read | One page of a folder (`label:/path`, `pageToken`) on any provider |
| `cloud_find` | read | Name/content search on one or all accounts, optionally below a folder |
| `cloud_read` | read | Plain-text files only, up to 2 MB |
| `cloud_mkdir` | write | `label:/A/B/New`; creates missing parents and reuses existing folders |
| `cloud_move` | write | Within one account; never overwrites |
| `cloud_rename` | write | In place; when `CROSSDRIVE_NAMING_RULE` is set it applies to files unless `allowNonStandardName` |
| `cloud_trash` | write | Recoverable trash only |
| `transfer` | write | Copy or move a file or folder between any two accounts (below) |

The read tools are available to read-only tokens. Accounts connected with `mode: "read"` refuse every write. Every write
is recorded in the audit log.

## transfer

```
transfer { from: "work:/Reports", to: "client-a:/Inbox", move: false, dryRun: true }
```

- **Dry run is the default.** It walks the source (up to 5000 items) and returns counts, total bytes and the issues
  list: Google Docs/Sheets/Slides/Drawings that will be exported (docx/xlsx/pptx/png), Google types that cannot leave
  Google (Forms, Sites, ...), shortcuts (not transferred), names that will be renamed for the target, names or paths that
  are too long, and files over the target's size limit.
- **Run** with `dryRun: false`. Each call works for up to `maxFiles` items (default 200) or about 4 minutes, then
  returns `done: false` and a `cursor`. Call again with the same `from`, `to` and `move` plus the `cursor` until
  `done: true`. A file too large to finish in one call keeps its upload session in the cursor and continues with a
  ranged download.
- **Verification**, per file: the destination size must equal the bytes sent. The bytes are hashed in transit and
  compared with the source's own hash (Drive md5, OneDrive quickXorHash, Dropbox content_hash) and with the hash the
  destination reports. A file that fails verification has its fresh copy trashed and is reported as failed. Files that
  continue across calls are checked by size, plus a direct hash comparison when both sides use the same hash kind.
- **Never overwrites.** An existing destination file with the same name is skipped if it is identical (same size, same
  hash where comparable) and is otherwise reported as a conflict. Existing folders are merged. Running the same
  transfer again is therefore safe, and it is how you retry failures.
- **Move** trashes the source top item only on the final call and only if no item in the whole transfer failed or was
  left behind. Otherwise the report explains why nothing was trashed. Items added to the source while a transfer is
  running may not be copied before the move trashes the source, so do not edit a tree while moving it.
- **Google → Google** is delegated to the existing server-side Drive copy, so no bytes pass through the server. Drive
  copies are checked by size and md5 for single files only.

### Limits applied by the dry run and the transfer

| Target | Names | Path | File size |
|--------|-------|------|-----------|
| OneDrive | `" * : < > ? / \ \|` replaced by `_`; trailing space/period removed; `.lock`, `CON`, `PRN`, `AUX`, `NUL`, `COM0-9`, `LPT0-9`, `desktop.ini` get `_`; leading `~$` and `_vti_` changed | 400 characters | 250 GB |
| Dropbox | `/ \` replaced; trailing space removed; `< > : " \| ? *` and a trailing period are reported as warnings | under 260 characters | 350 GB |
| Google Drive | unchanged | none | 5 TB |

Renames are deterministic, so a resumed transfer finds what it created earlier.

### Throughput and serverless limits

Data passes through the function in roughly 8 MB chunks (OneDrive: 25 × 320 KiB). Memory use stays around one chunk
per transfer. Google exports are buffered whole because Drive caps them at 10 MB. Throttling (HTTP 429/503 with
`Retry-After`) is retried up to four times per request, waiting at most 30 s each time. Open upload sessions of an
abandoned transfer expire on their own: Graph sessions after inactivity, Dropbox after 48 h, Drive after about a week.
The resume cursor contains pre-authorised upload URLs for unfinished files. Treat it like a credential while a
transfer is running.
