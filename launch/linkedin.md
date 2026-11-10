# LinkedIn

If you run more than one business, you probably have more than one Google account, and AI assistants only ever see one
of them.

I run several small companies, so my files and mail are spread across five Google accounts. Claude's built-in Drive
connector handles one account at a time, which meant the AI could tidy one drive while staying blind to the rest, and
moving a document between companies was manual.

So I built Crossdrive and released it as open source tonight. It is a small server you deploy to your own Vercel
account with your own Google OAuth client, and it gives Claude, ChatGPT or any MCP client one connection to all your
Drive and Gmail accounts.

What I cared about most was not letting an AI do anything irreversible:
- Trash is the only delete; permanent delete does not exist.
- Mail is draft-only by default, and any account can be set to read-only.
- Every write is logged, with actions only, never file or mail contents.
- A disconnect-everything button works from your phone.

What it is not: it covers Drive and Gmail only, there is no hosted version (Google's verification for these scopes
requires an annual security assessment), and the OneDrive and Dropbox support is beta and untested on live accounts.

If you juggle several accounts or entities and want to try it, the setup guide is in the repository:
https://github.com/vivek-gelp/crossdrive

I would value feedback from anyone who gets stuck during setup.

#OpenSource #MCP #GoogleDrive #AI
