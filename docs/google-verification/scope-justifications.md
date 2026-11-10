# Scope justifications (draft)

Drafts for the "how will you use the data" fields. Edit to match the product as shipped. Google may push back on the
breadth of `drive`; be prepared to explain why narrower scopes fail, and to reconsider the design (see the closing
section). Whether each scope is sensitive or restricted must be confirmed against Google's current scope list.

## https://www.googleapis.com/auth/drive

Crossdrive lets a user's own AI assistant organise files across the user's Google Drive accounts: search, move, rename,
trash, copy, share and upload. The assistant works on files the user did not create with Crossdrive (the user's existing
folders, files shared with them, and Shared Drives).

Why narrower scopes are insufficient: `drive.file` only covers files created or opened by the app itself, so it cannot
list, search, move or rename the user's existing files, which is the core purpose. `drive.readonly` and
`drive.metadata.readonly` do not permit moving, renaming, trashing, copying or uploading. `drive.appdata` is unrelated.
`drive.install` is unrelated. Only `drive` allows the app to act on the user's existing files, including those in
Shared Drives and files shared by others, which the user explicitly asks the assistant to organise.

Data handling: file contents are streamed to the user's chosen AI client on request and are not stored by Crossdrive.
Only metadata needed to execute an operation and an audit entry (tool, account, item id, outcome) are recorded. There is
no permanent delete; deletion is to Drive trash only.

## https://www.googleapis.com/auth/gmail.modify

Used to apply and remove labels, archive, mark read or unread and move messages to trash on the user's request, and to
read messages and threads for the user's assistant (search, read, attachment download).

Why narrower is insufficient: `gmail.readonly` allows reading but not labelling, archiving or trashing. `gmail.labels`
manages label definitions but cannot apply labels to messages. `gmail.metadata` excludes message bodies and attachments.
Only `gmail.modify` covers reading plus label, archive and trash changes in one scope. We do not request
`https://mail.google.com/` because we never permanently delete.

Data handling: message content is passed to the user's AI client only when requested and is not stored; the audit log
records recipients, subject and ids for writes but never bodies.

## https://www.googleapis.com/auth/gmail.compose

Used to create and update drafts (including reply drafts with Drive attachments) on the user's request. In the default
configuration this is the only way mail is composed: the user reviews and sends the draft from Gmail.

Why narrower is insufficient: `gmail.modify` does not include creating drafts (unsure; check Google's scope table), and
no narrower scope than `gmail.compose` creates drafts. Without it the assistant cannot prepare a reply for the user to
review.

Data handling: draft content is created from text the user's assistant supplies and is stored only in the user's own
Gmail.

## https://www.googleapis.com/auth/gmail.send

Used only when the user explicitly sets an account's mail mode to "send" on the connect page. It allows the assistant to
send a draft or a reply the user has asked for, optionally limited to an allowlist of recipients. For accounts in the
default "draft" mode the scope is granted but the server refuses to send.

Why narrower is insufficient: sending requires `gmail.send` or `gmail.compose` plus `gmail.send`; there is no narrower
send scope. If the review rejects send, the product can drop this scope and remain draft-only (see below).

Data handling: nothing is stored beyond an audit entry with recipients, subject, attachment names and Gmail ids.

## Scopes not requested

`https://mail.google.com/` (would allow permanent deletion), Drive `drive.readonly` as a substitute for `drive`, and
Calendar, Contacts or any other product scope.

## Design fallback if review pushes back

- Offer the hosted app with `gmail.compose` and `gmail.modify` only (draft-only; no `gmail.send`), keeping send for
  self-hosters.
- Offer separate "read-only" consent that requests `drive.readonly` and `gmail.readonly` only, with writes available
  only on self-hosted deployments (unsure whether the product is still compelling in that mode).
