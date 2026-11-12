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

Open-source, self-hosted MCP server: one URL onto several Google Drive and Gmail accounts for your AI client. Trash-only delete, draft-only mail by default, read-only accounts enforced in code, audit log. Version 1.0.1, tested on live Google accounts.

## Topics

Open Source, Artificial Intelligence, Developer Tools, Productivity

## First comment (maker)

Hi, I am the maker. I have five Google accounts across several companies, and Claude's Drive connector only sees one at
a time. Crossdrive is the tool I built to fix that: you deploy it to your own Vercel account with your own Google OAuth
client, label your accounts, and your AI client gets one connection to all of them.

Three things I would flag honestly. First, setup takes real effort (a Google Cloud project, a Vercel deploy); the docs
are written step by step, and I would love to hear where they lose you. Second, I tested 1.0.1 live over four rounds on
two Gmail accounts and one Workspace account with a scripted OAuth client, and fixed what those rounds broke; I have not
yet run it from the Claude or ChatGPT apps themselves. Third, it is Drive and Gmail only, and the OneDrive and Dropbox
support is beta and not yet tested on live accounts.

What I am proudest of is what it will not do: no permanent delete, no forwarding filters, no mail sent by default, no
change to an account you marked read-only, and every write is logged. Ask me anything about the design.
