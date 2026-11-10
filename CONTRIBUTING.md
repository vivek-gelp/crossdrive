# Contributing to Crossdrive

Thanks for helping. Small, focused changes are easiest to review.

## Before you start

- For anything larger than a bug fix, open an issue first so we can agree on the approach.
- Read [CLAUDE.md](CLAUDE.md). It lists the architecture and the invariants that every change must keep: trash is the
  only delete, safety gates live in code, every write is audited and supports `dryRun`, content is untrusted data.
  Changes that add permanent deletion, forwarding filters or URL fetching from document content will not be accepted.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

Requirements: Node 24 and pnpm 10.

```bash
pnpm install
cp .env.example .env.local     # fill in values; see docs/setup-google.md
pnpm dev
```

Tests need no network and no Google account: Drive and Gmail are faked in `src/lib/testing/`.

## Before opening a pull request

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
node scripts/check-pdf.mjs      # if you touched a parser or readers.ts
```

- Write or extend a test before changing behaviour.
- Update `README.md`, `docs/tools.md`, `.env.example` and `docs/CHANGELOG.md` if a tool, variable or route changed.
- Never commit secrets, tokens, real email addresses or personal file names. Use `example.com` addresses in tests and docs.
- Keep tools small: one tool does one thing. `batch` only sequences existing operations.
- No new runtime dependency without a reason stated in the pull request.

## Commit messages

Imperative subject line, and a body that explains why the change is needed.

## Beta providers

OneDrive and Dropbox support is beta and has not been tested against live accounts by the maintainers. Reports from real
accounts are especially valuable; please include what you ran and what you saw, with identifiers redacted.

## Conduct

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
