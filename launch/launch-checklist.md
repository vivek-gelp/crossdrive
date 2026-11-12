# Launch checklist

For version 1.0.1. Public links: the repository https://github.com/vivek-gelp/crossdrive and the landing page
https://vivek-gelp.github.io/crossdrive/. Ordered by time.

## Before announcing

1. Run a secret scanner (for example `gitleaks detect` or `trufflehog git file://.`) over the whole tree and history.
2. Grep the tree for the owner's personal names, company names, email addresses and old deployment domains; expect
   zero hits.
3. Confirm `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass on a clean
   clone, and `node scripts/check-pdf.mjs`.
4. Push the 1.0.1 commits, confirm CI is green, and update the landing page (gh-pages) so it makes no claim the README
   does not.
5. Tag `v1.0.1` and publish the GitHub release from `launch/release-notes-1.0.1.md`.
6. Re-check the README comparison table and launch/registries.md against their live sources (not verifiable offline).
7. Deploy a throwaway copy through the README's Deploy button from an account that does not own the repository,
   following only the docs. This has not been done yet; fix any step that needed guessing, and move the item out of
   "Not yet verified live" in the README only if it worked.
8. If possible, connect at least one real AI client app (Claude web or desktop, Claude Code) to a deployment and record
   the result. Until then, every post must keep saying the live tests used a scripted OAuth client.
9. Record the demo GIF and add it where the README has the placeholder comment. Use a client that was actually tested;
   do not show a phone app unless it has been tried.

## Launch window (evening in US time zones is better for Hacker News)

10. Submit Show HN (`launch/show-hn.md`); post the first comment immediately.
11. Stay on the thread. Answer setup questions fast and note every point where the docs failed.
12. Post r/ClaudeAI and r/mcp at least a few hours apart, not at the same minute (`launch/reddit-*.md`).
13. Publish the X thread and the LinkedIn post.

## Day 1

14. Triage issues; label setup problems and turn the top three confusions into doc fixes the same day.
15. Submit to the official MCP registry (`launch/registries.md`, section 1) if the remote-server question is resolved.
16. Submit to Glama, PulseMCP and mcp.so.

## Day 2

17. Open the awesome-mcp-servers pull request.
18. Ship a patch with documentation and small fixes from day 1 feedback; mention it in the thread.
19. Check Smithery fit; submit only if it accepts self-hosted listings.

## Day 3

20. Product Hunt, if you want it, on a weekday with the GIF and social card ready (`launch/product-hunt.md`).
21. Write down what broke or confused people, update the README comparison table if any competitor fact was wrong, and
    decide the first roadmap item (rules engine, stdio/Docker mode, folder-scoped tokens).
22. When anyone reports testing OneDrive, Dropbox, a client app, disconnect/reconnect or the recipient allowlist against
    a live deployment, record the result and update "What has been tested" in the README.

## Do not

- Do not claim numbers (stars, users, benchmarks) in any post.
- Do not say a client, provider or feature works unless the README lists it as verified live.
- Do not name the companies or accounts behind the origin story; "five Google accounts across several companies" is
  enough.
- Do not post identical text in several communities; use the prepared variants.
- Do not argue with competitors' maintainers; the README says where they are better.
