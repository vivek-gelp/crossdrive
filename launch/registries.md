# Registry submissions

Verified on 2026-11-10 against the primary pages named in each section. Nothing here has been submitted.

Crossdrive is self-hosted: every user deploys their own instance, there is no shared public endpoint, and nothing is published
to npm. That matters because most directories list either an installable package or a publicly reachable URL. Do not submit
any maintainer's private deployment as a public endpoint: it holds real accounts.

Anything marked UNCONFIRMED could not be established from a primary source.

## Summary, ordered by expected value

| # | Directory | Eligible tonight? | Blocking requirement / note |
|---|-----------|-------------------|-----------------------------|
| 1 | punkpeye/awesome-mcp-servers (PR) | YES | Public GitHub repo you install and run yourself is exactly its scope. Feeds Glama too. |
| 2 | Glama | YES (listing); claim after | Add `glama.json` to the repo root, then claim. Exact "Add Server" form fields UNCONFIRMED. |
| 3 | mcp.so | YES | Repo URL form; free tier is review-queued, $39 skips review. |
| 4 | mcpservers.org (feeds wong2/awesome-mcp-servers) | YES | Web form only; wong2 repo accepts no PRs. Free review up to 2 weeks. |
| 5 | Cline MCP Marketplace | YES (repo-based) | GitHub issue with repo URL, 400x400 PNG, and proof Cline set it up from the README alone. |
| 6 | Vercel Templates | AFTER a public demo exists | Needs "a working demo deployed on Vercel" and a Deploy button in the README. |
| 7 | MCP Market (mcpmarket.com) | YES | Repo URL form; free queue 4-6 weeks, $29 for 24 hours. |
| 8 | Official MCP Registry | NO | `remotes` must be a publicly reachable URL; no package to point at. |
| 9 | PulseMCP | NO (paused) | Page says new submissions are paused; it ingests from the official registry. |
| 10 | Smithery | NO | Publishing needs a public HTTPS Streamable HTTP URL (or Smithery-hosted build). |
| 11 | Anthropic Connectors Directory | NO | Needs a public `https://` server URL; per-user URLs publish only if Verified. |
| 12 | Docker MCP Catalog | AFTER a Dockerfile / image exists | Requires a working Docker deployment; Crossdrive has no Docker mode yet. |
| 13 | Cursor Directory | UNCONFIRMED | Page rate-limited (HTTP 429) when fetched. |

## Shared copy

- Name: Crossdrive
- Short description (95 characters, fits the registry's 100-character limit): Self-hosted MCP server: one URL for several Google Drive and Gmail accounts, trash-only delete.
- Medium description (list entries): Self-hosted remote MCP server: one URL for several Google Drive and Gmail accounts with fan-out search, cross-account copy, trash-only delete and an audit log.
- Long description: Crossdrive is a self-hosted remote MCP server that gives MCP clients with remote-server and OAuth support (such as Claude, Claude Code or ChatGPT) one URL onto several Google Drive and Gmail accounts, addressed as `label:/path`. Fan-out search, resumable cross-account copy, batch with dry-run, undo, duplicates, Gmail search/read/draft/label, per-account read-only mode, append-only audit log, OAuth 2.1 with PKCE and dynamic client registration. Safety is enforced in code: trash is the only delete, mail is draft-only by default. OneDrive and Dropbox are beta and untested against live accounts.
- Repository: https://github.com/vivek-gelp/crossdrive
- Licence: MIT
- Language: TypeScript (Next.js). Scope: cloud service. Deployment: bring-your-own Vercel.
- Categories: file systems / cloud storage, email, productivity

## 1. punkpeye/awesome-mcp-servers (pull request)

Source: https://github.com/punkpeye/awesome-mcp-servers (README.md, CONTRIBUTING.md). Confirmed.

CONTRIBUTING rules, confirmed:

- Scope is "servers with a public GitHub repository that you install and run yourself". Remote-only (hosted URL, no installable
  package) servers go to a separate list, awesome-remote-mcp-servers. Crossdrive is installed and run by each user, so it fits
  this list. Say "self-hosted" in the description so a maintainer does not move it.
- Fork, branch, edit `README.md`, push, open a PR.
- Entry = server name linked to its repository + brief description, under the relevant category. One server per line,
  alphabetical within the category. Follow the existing format, capitalisation and punctuation. Double-check links.
- No exact line template and no PR title format are given. (Only automated agents are asked to append three robot emoji to
  the title; a human PR does not.)

Legend (confirmed from README): language TypeScript = 📇; scope Cloud Service = ☁️ (Local Service = 🏠, "use local when the MCP
server is talking to a locally installed software"); OS icons only if it is OS specific (not needed).

Categories in the index include "Cloud Platforms" and "File Systems"; there is no "Cloud Storage" heading. Exact body heading
text was not visible in the fetched portion, so open the README and place the line under the section that matches best
(File Systems or Cloud Platforms), alphabetically.

Line to add (modelled on existing entries; the per-entry Glama badge appears on many entries and is added after Glama lists
the repo, see section 2):

```
- [vivek-gelp/crossdrive](https://github.com/vivek-gelp/crossdrive) 📇 ☁️ - Self-hosted remote MCP server: one URL for several Google Drive and Gmail accounts with fan-out search, cross-account copy, trash-only delete and an audit log.
```

PR title: `Add Crossdrive`. Body: one paragraph - what it is, MIT, self-hosted (each user deploys their own instance), author is the submitter.

Eligible tonight: YES. Glama says it also picks up entries from this list (community report, UNCONFIRMED from Glama's own docs).

## 2. Glama (https://glama.ai/mcp/servers)

- Directory page has an "Add Server" button (confirmed present on the page; its target and form fields were not exposed to the
  fetcher, so the exact fields are UNCONFIRMED). Community guides say sign in with GitHub, click Add Server, and give the
  repository; no programmatic API (UNCONFIRMED).
- Claiming is confirmed (https://glama.ai/blog/2025-07-08-what-is-glamajson): add `glama.json` to the repository root, then run
  the Claim flow again so Glama re-reads it. Claiming lets you edit name/description, configure a Docker image, see usage
  reports. Personal-account repos can alternatively claim by authenticating with GitHub; organisation repos must use `glama.json`.

`glama.json` to commit at the repository root (schema URL and shape confirmed):

```json
{
  "$schema": "https://glama.ai/mcp/schemas/server.json",
  "maintainers": ["vivek-gelp"]
}
```

- Docker: claiming lets you configure a Docker image; whether Glama requires one for a score or "can be installed" status is
  UNCONFIRMED. Expect a lower grade until Crossdrive ships a Dockerfile.

Eligible tonight: YES for listing and claiming.

## 3. mcp.so

Source: https://mcp.so/submit (confirmed).

- Form: type (MCP Server / Remote Server / MCP Client / AI Product), repository URL (required), name. Optional paid
  submission: one-time $39 for "publishing without review", verified badge, priority placement, dofollow link. Free submissions
  go through standard review (length not stated). Whether sign-in is required is not stated on the page.
- Choose "MCP Server" (not "Remote Server", which implies a hosted URL). Paste name and long description from the shared copy.

Eligible tonight: YES (free tier, review queue).

## 4. mcpservers.org and wong2/awesome-mcp-servers

- wong2/awesome-mcp-servers is still active (4.4k stars) but states "We do not accept PRs. Please submit your MCP on the
  website: https://mcpservers.org/submit". Confirmed. So there is no PR route.
- Form (https://mcpservers.org/submit, confirmed): server name; category (Development, Database, Web Scraping, Cloud Service,
  Memory, Other); short description; repository/website/docs link; optional Official MCP Registry name (leave blank);
  "remote connection support" checkbox (leave unchecked, there is no shared remote); contact email. Free = review up to 2
  weeks; Premium $39 = 24 hours, badge, priority.
- Category: Cloud Service. Listing format on the wong2 list, for reference: `**[Name](repo)** - Short description.`

Eligible tonight: YES (form; free review up to 2 weeks).

## 5. Cline MCP Marketplace

Source: https://github.com/cline/mcp-marketplace (confirmed).

- Create an issue with template `mcp-server-submission.yml`: GitHub repo URL, a 400x400 PNG logo, reason for addition, and a
  confirmation that you gave Cline only the `README.md` and/or `llms-install.md` and watched it set the server up.
- Reviewed on community adoption, developer credibility, maturity and security; target "within a couple of days".
- Fit: the marketplace installs by cloning a repo. Whether it accepts a deploy-your-own remote server is not stated
  (UNCONFIRMED). A new repo with no stars may be marked down on adoption.
- Prerequisites missing: a logo PNG; an `llms-install.md` is optional but advisable (walk Cline through the Vercel deploy and
  Google OAuth setup).

Eligible tonight: YES if the logo and the Cline setup test are done; likely low odds on adoption criteria.

## 6. Vercel Templates

Source: https://vercel.com/templates/submit (confirmed by fetch; the form itself is behind login).

- Requirements stated: any deployable frontend framework; Next.js must use App Router; follow Vercel's best practices; "must
  have a working demo deployed on Vercel"; README with a Vercel Deploy button; polished design per Web Interface Guidelines.
- Community reports: public GitHub repo, purpose description, thumbnail (1200x630). The form was reported broken in 2024-25 and
  working again in March 2026; review latency is long and unpredictable.
- Blocker: a public demo. Crossdrive is an OAuth server with no UI to demo; a demo instance would be a live endpoint that must
  not hold real accounts. Decide whether to deploy a demo with a throwaway Google test project, otherwise skip.

Eligible tonight: NO - after a demo deployment (and a Deploy button in the README) exists.

## 7. MCP Market (mcpmarket.com)

Source: https://mcpmarket.com/submit (confirmed). GitHub repo URL (required); choose MCP Server vs Agent Skill, optionally
Remote MCP; optional Try Now link; email. Free queue "typically 4-6 weeks"; $29 one-time for listing within 24 hours.
No eligibility criteria stated.

Eligible tonight: YES (form, free queue).

## 8. Official MCP Registry (registry.modelcontextprotocol.io)

Sources: https://github.com/modelcontextprotocol/registry (docs/modelcontextprotocol-io/quickstart.mdx, remote-servers.mdx).
Confirmed.

- Current schema in the quickstart: `https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json` (the old
  2025-07-09 URL in the previous draft is out of date). Check `mcp-publisher validate` for any newer revision.
- CLI `mcp-publisher`: `init`, `validate`, `login github`, `publish`, `status`, `logout`.
- Namespace: with GitHub auth the `name` must start with `io.github.<github-username>/`; mismatch gives "You do not have
  permission to publish this server." DNS auth allows custom-domain names.
- `description` is limited to 100 characters.
- The registry hosts metadata only. A package entry requires the package to be published first (npm etc.). Crossdrive has none.
- Remote-only entries need a `remotes` array; the URL "MUST be publicly accessible". The registry checks namespace control,
  not URL control. `remotes` URLs may use `{curly_brace}` variables with `default`, `choices`, `isRequired`, `isSecret`
  (intended for multi-tenant hosts). Remotes and packages may coexist.
- A repository-only entry (no `packages`, no `remotes`) is not described anywhere in the docs; the quickstart says a
  remote-only server "must include a `remotes` entry". Treat as not allowed. UNCONFIRMED whether the API server rejects
  it at publish time (`mcp-publisher validate` would tell you without publishing).
- A templated URL such as `https://{host}/api/mcp` would be a public-URL placeholder, not a reachable endpoint. UNCONFIRMED
  that the registry accepts it; it would also list a server nobody can connect to by default. Not recommended.

Eligible tonight: NO. Blocking requirement: a publicly reachable `remotes` URL (or an npm/OCI/etc. package).
Ready for later, if a public endpoint or package appears (draft, valid against the current quickstart shape; do not publish
with a placeholder URL):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.vivek-gelp/crossdrive",
  "title": "Crossdrive",
  "description": "Self-hosted MCP server: one URL for several Google Drive and Gmail accounts, trash-only delete.",
  "repository": {
    "url": "https://github.com/vivek-gelp/crossdrive",
    "source": "github"
  },
  "version": "1.0.1",
  "remotes": [
    {
      "type": "streamable-http",
      "url": "https://<PUBLIC-ENDPOINT>/api/mcp"
    }
  ]
}
```

Commands: `mcp-publisher init`, replace `server.json`, `mcp-publisher validate`, `mcp-publisher login github`,
`mcp-publisher publish`.

## 9. PulseMCP (https://www.pulsemcp.com/submit)

Confirmed: "We are not accepting new MCP server or client submissions right now, and we are not making changes to existing
listings." No reopen date. The page recommends publishing to the Official MCP Registry, which PulseMCP picks up
automatically. Since that route is blocked for Crossdrive (section 8), there is no PulseMCP path now.

Eligible tonight: NO - submissions paused.

## 10. Smithery (https://smithery.ai)

Sources: search results quoting smithery.ai/docs/build/publish and /build/external; those doc pages returned 404 to the
fetcher, so details are partly UNCONFIRMED.

- Reported: publish an already-deployed server by giving a public HTTPS Streamable HTTP URL at smithery.ai/new, or CLI
  `smithery mcp publish "https://your-server.com/mcp" -n @your-org/your-server`. `smithery.yaml` only applies to
  Smithery-hosted builds (runtime typescript or container with Dockerfile).
- Fit: a deploy-your-own server has no single URL. A Smithery-hosted build would make Smithery the shared endpoint, holding
  everyone's Google tokens in one place, which contradicts the design. Skip.

Eligible tonight: NO - needs a public endpoint or a Smithery-hosted build.

## 11. Anthropic Claude Connectors Directory

Sources: https://claude.com/docs/connectors/building/submission.md and https://claude.com/docs/directory/publish.md. Confirmed.

- Route: developer portal https://claude.ai/directory/manage -> Submit new -> MCP connector. Any paid Claude plan (Pro, Max,
  Ultra, Team, Enterprise) can submit; Free cannot.
- Requirements: remote server reachable at an `https://` URL; OAuth 2.0 for authenticated services; every tool has a `title`
  and a `readOnlyHint` or `destructiveHint`; documentation URL, privacy policy URL, support contact, icon; a reviewer test
  account with a populated account; seven compliance acknowledgments. Local servers cannot be submitted alone (only via a
  plugin).
- Self-hosted: the portal's Connection step has "Users connect to different URLs" (Multiple URLs / URL pattern), but such a
  listing "can be published only once it has the Verified label", which Anthropic decides in review with no separate
  application. A pure deploy-your-own server has no URL for a reviewer test account.
- Alternative for self-hosters: users add Crossdrive as a custom connector by URL in Claude (documented as the way to test
  before submission); no directory entry needed.
- Plugin route (a GitHub repo with skills and an MCP reference) is a different submission type and is UNCONFIRMED as a fit.

Eligible tonight: NO. Blocking requirement: a single public `https://` endpoint, or Verified status for a per-customer URL
pattern.

## 12. Docker MCP Catalog (https://github.com/docker/mcp-registry)

Confirmed: submit by pull request; option A Docker builds and signs the image (published as `mcp/<name>`), option B you supply
a pre-built image. Requirements: security best practices, documentation, a working Docker deployment, MCP compatibility, error
handling and logging. Local-vs-remote handling not stated.

Eligible tonight: NO - after a Dockerfile / working Docker deployment exists (the roadmap item). A Next.js server with
per-user OAuth state in a database may also not suit a stdio-style catalog image (UNCONFIRMED).

## 13. Cursor Directory (https://cursor.directory/mcp/new)

Fetch returned HTTP 429, nothing confirmed. UNCONFIRMED: submission form, requirements, eligibility. Retry later.

## Not researched

Official Anthropic plugin directory, PulseMCP Anthropic-style ingestion, Hugging Face / other aggregators: not checked.
