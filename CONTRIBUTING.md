# Contributing to LAURA

Pull requests are welcome. This repo powers a live production swarm and a
public dashboard, so every change is reviewed by the maintainers before it
lands.

## Ground rules

- **Nothing merges without maintainer approval.** The `main` branch is
  protected: all outside changes come in through pull requests and require a
  maintainer review. Direct pushes are restricted to the maintainers and the
  production deploy key.
- **Never include secrets in a PR.** No API keys, RPC URLs with embedded
  keys, wallet private keys, bot tokens, or `.env` files. PRs containing
  secrets are closed and the secret is treated as burned.
- **Keep the runtime safe by default.** The swarm executes real on-chain
  transactions when an operator configures a wallet. Changes to the launchpad
  executor, treasury caps, or builder must preserve the hard code-level caps
  (spend per deploy, deploys per day, backoff on failure). PRs that weaken a
  cap need an explicit rationale and will get extra scrutiny.
- **Mock mode must keep working.** `npm install && npm run dev` with zero env
  vars should always produce a working console (deterministic fallback
  writer, live public feeds). If your change adds a dependency on a key or
  service, gate it and degrade gracefully.

## Practical notes

- Build check: `npm run build` (plain `tsc` shows spurious RouteContext
  errors; the Next build is the source of truth).
- Dashboard copy style: visible UI copy avoids hyphens and dashes in prose
  (use middots or periods). Markdown docs like this one are exempt.
- Keep source files valid UTF-8. Prefer pure ASCII in new files; multi-byte
  characters have been corrupted by editing tools in this repo before.
- State lives in `data/` (git-ignored). Never commit runtime state.

## Getting help

Open an issue for questions, ideas, or architecture discussion. For anything
security-sensitive, see [SECURITY.md](./SECURITY.md) and do not open a public
issue.
