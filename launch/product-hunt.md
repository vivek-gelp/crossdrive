# Product Hunt

Product Hunt expects a product people can try. Because Crossdrive is self-hosted, link the repository and make the call
to action "deploy your own". Prepare the gallery with the social card and the demo GIF.

## Name

Crossdrive

## Links

- Website: https://vivek-gelp.github.io/crossdrive/
- Repository: https://github.com/vivek-gelp/crossdrive

## Tagline (60 characters max)

One safe MCP connection for all your Google accounts

## Description (260 characters max)

Free, open-source, self-hosted MCP server: one URL onto several Google Drive and Gmail accounts for your AI client. Trash-only delete, draft-only mail by default, read-only accounts enforced in code, audit log. Version 1.0.1, tested on live Google accounts.

## Topics

Open Source, Artificial Intelligence, Developer Tools, Productivity

## First comment (maker)

Hello, I am the maker. I have five Google accounts across several companies, and Claude's Drive connector only sees one
at a time. I built Crossdrive for myself, it helped, and I am sharing it in case it helps you. You deploy it to your own
Vercel account with your own Google OAuth client, label your accounts, and your AI client gets one connection to all of
them.

Three things to know up front. Setup takes real effort (a Google Cloud project, a Vercel deploy), and if you get stuck,
open an issue or discussion and I will help. I tested 1.0.1 live over four rounds on two Gmail accounts and one
Workspace account with a scripted OAuth client, and fixed what broke; I have not yet run it from the Claude or ChatGPT
apps. It is Drive and Gmail only, and OneDrive and Dropbox are beta and untested live.

It will not permanently delete, create forwarding filters, send mail by default, or change an account you marked
read-only, and every write is logged. Thank you for reading, and for any criticism, especially on security. If it is not
right for you, the README lists other servers. Tell me what would make it more useful.
