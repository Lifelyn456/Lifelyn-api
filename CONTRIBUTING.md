# Contributing to Lifelyn API

Thanks for looking at this. A few ground rules before you send a PR.

## Ground rules

- **No real patient data, ever.** Test fixtures must be synthetic.
- This is a **fail-closed** system. If a required dependency (KMS, malware scanner, Stellar signer, provider verifier) is unavailable, the endpoint must return an explicit error — never a fake success. See `src/common/production-config.ts`.
- Every new endpoint needs Zod validation, an authorization check, safe error responses (no leaking internals), OpenAPI documentation, an audit-event write where relevant, and a test for the denied path — not just the happy path.
- Never put a vendor SDK directly in a route handler; keep external services behind an adapter (see `src/integrations/`).

## Getting set up

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d
pnpm db:generate
pnpm db:migrate
cp .env.example .env   # fill in the blanks
pnpm dev
```

## Before you open a PR

```bash
pnpm exec prisma validate
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

All must pass locally; CI runs the same checks (plus a real Postgres integration test) and will block merge otherwise.

## Commit style

Conventional commits: `type(scope): description` — e.g. `fix(auth): widen clock-skew tolerance`. Keep commits scoped to one logical change.

## Pull requests

- Open against `main`, describe what changed and why, link any related issue.
- If your change touches authorization, consent, encryption, or Stellar submission, call that out explicitly in the PR description — those get closer review.
- CI (`API checks` job) must be green before merge.

## Reporting bugs vs. security issues

Regular bugs: open a GitHub issue. Security vulnerabilities: see `SECURITY.md` — do not file those as public issues.
