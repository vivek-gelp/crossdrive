# LinkedIn

I have five Google accounts across several companies, and I wanted an AI assistant to work across them under rules I
could rely on: one account read-only, another allowed to draft mail but never send it. I built Crossdrive to do that for
myself, and it helped, so I have released it as open source (1.0.1) in case it helps you.

You deploy it to your own Vercel account with your own Google OAuth client. Every account sits under a label you choose,
and the server enforces the rules for each one: read-only or not, mail off, draft or send, trash as the only delete, and
a log of every write without contents. It can also copy, move and search between accounts.

There are user reports that Claude's built-in Google connectors are gaining support for several accounts. I have not
been able to confirm that; if you have it and only need to read and draft, it is the simpler route.

I tested Crossdrive live on real Google accounts first, which found real problems, such as a consent screen that could
not be approved in Chrome. Those are fixed. Drive and Gmail only; OneDrive and Dropbox are beta and untested live, and
the Claude desktop app is the only client verified so far.

Thank you to anyone who tries it. If you get stuck, tell me and I will help.

https://github.com/vivek-gelp/crossdrive

#OpenSource #MCP #AI
