# Demo video script

Google reviewers watch the video to confirm the consent flow, that the requested scopes are used, and that the app is
what the homepage says. Check Google's current video requirements first (unsure of the exact current wording; commonly:
YouTube link, English or with subtitles, shows the full OAuth consent screen including the client ID in the URL, shows
every scope being used). Record at 1080p, narrate or caption in English, use a test Google account with dummy files, and
no real personal data.

Length target: 4 to 6 minutes.

## Scenes

1. **Introduction (20 s).** Show the homepage on the verified domain. Say: "Crossdrive lets a user connect their own
   Google accounts and have their AI assistant organise Drive files and prepare Gmail drafts." Show the privacy policy
   link and the Limited Use disclosure.
2. **Sign in and start consent (30 s).** Open /connect, sign in, choose a label and modes. Click connect. Keep the browser
   address bar visible so the OAuth client ID in the Google URL can be read.
3. **The consent screen (30 s).** Pause on Google's consent screen. Show app name, account, and scroll through every
   requested permission: Drive, Gmail modify, compose and send. Tick all boxes and continue.
4. **Back in the app (15 s).** Show the account listed with its modes and token status.
5. **Drive scope in use (60 s).** In an AI client connected to the app, run: search for a file, list a folder, move a
   file into a folder, rename a file, trash a file and restore it. Show the result in Drive in a second window to prove
   the effect. Say why the full `drive` scope is needed: the files already existed and were not created by the app.
6. **gmail.modify in use (45 s).** Search a mailbox, read a message, apply a label, archive, trash. Show the result in
   Gmail.
7. **gmail.compose in use (30 s).** Ask the assistant to draft a reply. Show the draft appearing in Gmail drafts and not
   sent.
8. **gmail.send in use (30 s).** Change the account's mail mode to "send" on /connect, add one recipient to the allowlist,
   ask the assistant to send a draft to that recipient and show it delivered. Then try a recipient outside the allowlist
   and show it refused.
9. **Data handling and revocation (45 s).** Show the audit log (no bodies), explain that tokens are encrypted and no
   content is stored, then click disconnect and show the token revoked at Google (the app disappears from the account's
   third-party access page).
10. **Close (10 s).** Repeat the homepage and privacy policy URLs.

## Do not

- Do not show real customer data, real inboxes or secrets.
- Do not skip the consent screen; reviewers reject videos without it.
- Do not demonstrate any scope the justification does not claim.
