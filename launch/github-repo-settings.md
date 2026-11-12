# GitHub repository settings

## Description (under 120 characters)

Self-hosted MCP server for Google Drive and Gmail: labelled accounts, rules per account, copy and search between them.

(118 characters. Suggested on 13 November 2026 to replace the earlier "one URL for several Google Drive and Gmail
accounts" wording; the live setting has not been changed. Change it yourself under Settings, General, or with
`gh repo edit vivek-gelp/crossdrive --description "..."`.)

## Website

Leave blank, or link to docs/setup-google.md on GitHub.

## Topics (12)

```
mcp
model-context-protocol
mcp-server
google-drive
gmail
google-workspace
claude
chatgpt
self-hosted
vercel
nextjs
oauth
```

## Social preview

Settings, General, Social preview, Upload an image. Use `public/brand/social-card.png` (GitHub recommends 1280 x 640
pixels, minimum 640 x 320, under 1 MB). GitHub shows it when the repository link is shared on social networks and in chat
apps.

## Other settings

- Features: enable Issues and Discussions; disable Wiki and Projects unless used.
- Security: enable private vulnerability reporting (Settings, Code security), Dependabot alerts and secret scanning with
  push protection.
- Branch protection on `main`: require the CI check to pass, require pull requests.
- General: enable "Automatically delete head branches".
- Add the release `v1.0.1` from `launch/release-notes-1.0.1.md` once the push is verified.
- Pin the repository on your profile.
