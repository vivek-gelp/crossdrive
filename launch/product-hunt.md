# Product Hunt

Product Hunt expects a product people can try. Because Crossdrive is self-hosted, link the repository and make the call
to action "deploy your own". Prepare the gallery with the social card and the demo GIF.

## Name

Crossdrive

## Tagline (60 characters max)

One safe MCP connection for all your Google accounts

## Description (260 characters max)

Open-source, self-hosted MCP server. Give Claude, ChatGPT or any MCP client one URL onto several Google Drive and Gmail accounts. Trash-only delete, draft-only mail by default, per-account read-only, audit log, phone kill switch.

## Topics

Open Source, Artificial Intelligence, Developer Tools, Productivity

## First comment (maker)

Hi, I am the maker. I have five Google accounts across a few companies, and Claude's Drive connector only sees one at a
time. Crossdrive is the tool I built to fix that: you deploy it to your own Vercel account with your own Google OAuth
client, label your accounts, and your AI gets one connection to all of them.

Two things I would flag honestly. First, setup takes real effort (a Google Cloud project, a Vercel deploy); the docs are
written click by click, and I would love to hear where they lose you. Second, it is Drive and Gmail only, and the
OneDrive and Dropbox support is beta and not yet tested on live accounts.

What I am proudest of is what it will not do: no permanent delete, no forwarding filters, no mail sent by default, and
every write is logged. Ask me anything about the design.
