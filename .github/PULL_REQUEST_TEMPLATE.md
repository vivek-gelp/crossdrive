## What and why

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass
- [ ] Tests added or updated
- [ ] `node scripts/check-pdf.mjs` run if a parser changed
- [ ] README, `docs/tools.md`, `.env.example` and `docs/CHANGELOG.md` updated if a tool, variable or route changed
- [ ] No permanent delete, no URL fetching from document content, no secrets or personal data added
- [ ] Safety gates are enforced in code, not only in prompts or annotations
