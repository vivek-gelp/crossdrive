# Product Hunt

Product Hunt expects a product people can try. Because Crossdrive is self-hosted, link the repository and make the call
to action "deploy your own". Prepare the gallery with the social card and the demo GIF.

## Name

Crossdrive

## Links

- Website: https://vivek-gelp.github.io/crossdrive/
- Repository: https://github.com/vivek-gelp/crossdrive

## Tagline (60 characters max)

Your Google accounts, labelled and guarded, for any AI app

(57 characters)

## Description (260 characters max)

Free, open-source, self-hosted MCP server. Every Google Drive and Gmail account under a label, with rules per account
enforced on the server: read-only, mail off/draft/send, trash-only delete, audit log. Copy, move and search between
accounts. Version 1.0.1.

## Topics

Open Source, Artificial Intelligence, Developer Tools, Productivity

## First comment (maker)

Hello, I am the maker. I have five Google accounts across several companies, and I wanted an AI to work across them
under rules it could not talk its way past: this account read-only, that one allowed to draft but never send. I built
Crossdrive for myself, it helped, and I am sharing it in case it helps you.

One honest note first. There are user reports that Claude's built-in Gmail and Drive connectors are gaining support
for several accounts; I have not been able to confirm that. If you have it and only need to read and draft inside
Claude, use it, because it needs no setup. Crossdrive is for rules per account enforced on a server you own, for
copying, moving and searching between accounts, and for a connection that is not tied to one AI app.

Three things to know up front. Setup takes real effort (a Google Cloud project, a Vercel deploy), and if you get stuck,
open an issue or discussion and I will help. I tested 1.0.1 live over four rounds on two Gmail accounts and one
Workspace account and fixed what broke; the Claude desktop app is the only client verified so far. It is Drive and
Gmail only, and OneDrive and Dropbox are beta and untested live.

It will not permanently delete, create forwarding filters, send mail from an account you have not set to send, or
change an account you marked read-only, and every write is logged. Thank you for reading, and for any criticism,
especially on security. Tell me what would make it more useful.
