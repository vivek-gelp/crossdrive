# LinkedIn

If you work across more than one business, you probably have more than one Google account, and AI assistants only
ever see one of them.

My files and mail are spread across five Google accounts across several companies. Claude's built-in Drive connector
handles one account at a time, which meant the AI could tidy one drive while staying blind to the rest, and moving a
document between companies was manual.

So I built Crossdrive and released version 1.0.1 as open source. It is a small server you deploy to your own Vercel
account with your own Google OAuth client, and it gives an AI client that supports remote MCP servers one connection to
all your Drive and Gmail accounts.

What I cared about most was not letting an AI do anything irreversible:
- Trash is the only delete; permanent delete does not exist.
- Mail is draft-only by default, and any account can be set to read-only, which the server enforces in code.
- Every write is logged, with actions only, never file or mail contents.

Before announcing, I tested it live over four rounds on real Google accounts. Those tests found real problems,
including a consent screen that could not be approved in Chrome and a read-only account being given temporary access
when used as a copy source. Both are fixed in 1.0.1, and the README lists exactly what has and has not been tested.

What it is not: it covers Drive and Gmail only, there is no hosted version, the OneDrive and Dropbox support is beta and
untested on live accounts, and I have not yet run it from the Claude or ChatGPT apps themselves.

If you juggle several accounts or entities and want to try it: https://github.com/vivek-gelp/crossdrive
(overview: https://vivek-gelp.github.io/crossdrive/)

I would value feedback from anyone who gets stuck during setup.

#OpenSource #MCP #GoogleDrive #AI
