# Launch checklist

Ordered by time.

## Tonight, before the first push

1. Run a secret scanner (for example `gitleaks detect` or `trufflehog git file://.`) over the whole tree and history of the
   fresh repository. Publish from a new repository, not a made-public private one.
2. Grep the tree for the owner's personal names, company names, email addresses and the old deployment domain; expect
   zero hits.
3. Confirm `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass on a clean
   clone.
4. Re-check the README comparison table, the Deploy button flow and launch/registries.md against their live sources (not verifiable offline).
5. Create the GitHub repository at https://github.com/vivek-gelp/crossdrive (public), push, confirm CI is green.
6. Apply `launch/github-repo-settings.md`: description, topics, social preview, security features, branch protection.
7. Deploy a throwaway copy through the README button as a new user would, following only the docs. Fix any step that
   needed guessing. Record the 20-second demo GIF on a phone and add it where the README has the placeholder comment.
8. Tag and release `v1.0.0`.

## Tonight, launch window (evening in US time zones is better for Hacker News)

9. Submit Show HN (`launch/show-hn.md`); post the first comment immediately.
10. Stay on the thread. Answer setup questions fast and note every point where the docs failed.
11. Post r/ClaudeAI and r/mcp at least a few hours apart, not at the same minute (`launch/reddit-*.md`).
12. Publish the X thread and the LinkedIn post.

## Day 1

13. Triage issues; label setup problems and turn the top three confusions into doc fixes the same day.
14. Submit to the official MCP registry (`launch/registries.md`, section 1) if the remote-server question is resolved.
15. Submit to Glama, PulseMCP and mcp.so.

## Day 2

16. Open the awesome-mcp-servers pull request.
17. Ship a 1.0.1 with documentation and small bug fixes from day 1 feedback; mention it in the thread.
18. Check Smithery fit; submit only if it accepts self-hosted listings.

## Day 3

19. Product Hunt, if you want it, on a weekday with the GIF and social card ready (`launch/product-hunt.md`).
20. Write down what broke or confused people, update the README comparison table if any competitor fact was wrong, and
    decide the first roadmap item (rules engine, stdio/Docker mode, folder-scoped tokens).
21. If anyone reports testing OneDrive or Dropbox against a live account, record the result and update the beta wording.

## Do not

- Do not claim numbers (stars, users, benchmarks) in any post.
- Do not post identical text in several communities; use the prepared variants.
- Do not argue with competitors' maintainers; the README says where they are better.
