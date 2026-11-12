# Show HN

## Title (under 80 characters)

Show HN: Crossdrive – one MCP URL for all your Google Drive and Gmail accounts

(78 characters. Alternative: "Show HN: Self-hosted MCP server for several Google Drive/Gmail accounts")

## URL

https://github.com/vivek-gelp/crossdrive

(Landing page, for the comment if asked: https://vivek-gelp.github.io/crossdrive/)

## First comment (post immediately after submitting)

I have five Google accounts across several companies. Claude's built-in Drive connector sees one Google account, so an
AI could tidy one drive while staying blind to the other four, and moving a contract from one company's drive to
another's meant downloading and re-uploading it by hand.

Crossdrive is a remote MCP server you deploy to your own Vercel project with your own Google OAuth client. You label
each account yourself (`work:/Projects/2026`), `find` searches all of them and says which account failed instead of
returning less, folder trees copy between accounts with a resume cursor, and the safety rules live in code: trash is
the only delete, mail is draft-only by default, any account can be read-only, every write is audited, and unknown tool
arguments are rejected rather than ignored.

The part I want to be upfront about: before announcing, I deployed it for real and tested it over four rounds against
two consumer Gmail accounts and one Workspace account (the Workspace one read-only). It broke in ways the unit tests
had not caught. This post is about 1.0.1, which fixes what broke:

- The consent screen could not be approved in Chrome. The page sent `Referrer-Policy: no-referrer`, Chrome then sends
  `Origin: null` on the form POST, and my CSRF check refused it. No OAuth client could have connected to 1.0.0.
- A read-only account used as the source of a cross-account copy was given a temporary writer grant on the file (or the
  whole folder) for the destination account. "Read-only" did not mean read-only. Now a read-only source is streamed and
  never touched, and a writable source shares one file at a time, as reader, audited, removed within seconds.
- Read-only switches took up to a minute to apply (a per-instance cache), and a test write went through in that window.
- `mkdir` silently ignored a misnamed argument (`path` instead of `parentPath`) and created the folder at the Drive
  root. Every tool now rejects unknown arguments with a "did you mean" hint, and write tools need an explicit
  destination.
- Setup traps: a GitHub URL pasted as the base URL, a placeholder client id that ended in Google's `invalid_client`, a
  first deploy that needed a second one to set the base URL, and a connect page where signing in looked like
  connecting. Each now has a check or a clearer page.
- Smaller things: `audit` took about 55 seconds on a young log, binary uploads were stored as text/plain, and `find`
  could repeat an item across pages.

Not yet verified on live accounts, and labelled that way in the README:

- OneDrive and Dropbox support (beta; tested only against fakes of their APIs).
- Claude, Claude Code and ChatGPT themselves: the live tests used a scripted OAuth client through real Chrome.
- Google Docs/Sheets/Slides conversion when copying out of a read-only account, disconnect/reconnect and the
  "disconnect everything" switch, the mail recipient allowlist, and the Deploy to Vercel button from someone else's
  account.

Known limits: Drive and Gmail only (google_workspace_mcp is better if you want Docs, Sheets or Calendar); you create
your own Google Cloud project and OAuth client; on consumer Gmail, Google refuses an expiry on the temporary copy grant,
so there the protection is the immediate removal plus a leftover check; a copy from a writable account takes about 3
to 4 seconds per file.

MIT licensed. I would most like feedback on the setup docs (where did you get stuck?) and on the threat model in
docs/security.md.
