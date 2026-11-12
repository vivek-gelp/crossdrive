# LinkedIn

I have five Google accounts across several companies, and Claude's Drive connector sees one at a time. I built
Crossdrive to solve that for myself, and it helped, so I have released it as open source (1.0.1) in case it helps you.

You deploy it to your own Vercel account with your own Google OAuth client, and your AI client gets one connection to
all your Drive and Gmail accounts. Trash is the only delete, mail is draft-only by default, any account can be
read-only, and every write is logged without contents.

I tested it live on real Google accounts first, which found real problems, such as a consent screen that could not be
approved in Chrome. Those are fixed. Drive and Gmail only; OneDrive and Dropbox are beta and untested live, and I have
not yet run it from the Claude or ChatGPT apps. The README lists what has been tested.

Thank you to those who described this problem publicly, and to anyone who tries it. If you get stuck, tell me and I
will help.

https://github.com/vivek-gelp/crossdrive

#OpenSource #MCP #AI
