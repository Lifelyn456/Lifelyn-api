<p align="center">
  <img src="https://raw.githubusercontent.com/Lifelyn456/lifelyn-web/main/public/logo.png" alt="Lifelyn" width="120" />
</p>

<h1 align="center">Lifelyn API</h1>
<p align="center"><strong>Wallet-authorized patient memory, fail-closed by default.</strong></p>

<p align="center">
  <a href="https://github.com/Lifelyn456/Lifelyn-api/actions/workflows/ci.yml"><img src="https://github.com/Lifelyn456/Lifelyn-api/actions/workflows/ci.yml/badge.svg" alt="API checks" /></a>
  <img src="https://img.shields.io/badge/stack-NestJS%20%2F%20Fastify-E0234E" alt="NestJS/Fastify" />
  <img src="https://img.shields.io/badge/db-PostgreSQL%20%2B%20Prisma-336791" alt="PostgreSQL + Prisma" />
  <img src="https://img.shields.io/badge/license-unlicensed-lightgrey" alt="Unlicensed" />
</p>

NestJS/Fastify is the sole authorization and system-of-record boundary for [Lifelyn](https://github.com/Lifelyn456/lifelyn-web). Freighter wallet challenge signing is the only login mechanism — provider verification and passkey MFA add clinical privileges on top, they are never an alternative login. Every protected route fails closed (returns an explicit error) rather than falling back to fixture or synthetic data when PostgreSQL, Redis, private object storage, the malware scanner, the AI service, or the Stellar signer is unavailable.

## Table of contents

- [Maintainers](#maintainers)
- [What's implemented](#whats-implemented)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Testing](#testing)
- [Contributing](#contributing)
- [Contributors](#contributors)

## Maintainers

| | Name | Role | Contact |
| --- | --- | --- | --- |
| 🧑‍💻 | Chijioke | Maintainer | [@precious1joe](https://t.me/precious1joe) on Telegram · [@Cjay-Cyber-2](https://github.com/Cjay-Cyber-2) on GitHub |

## What's implemented

Wallet identity and profile resolution, passkey MFA, provider verification callbacks, encrypted record upload/finalization/source access, ingestion and reindex queues, normalized timeline review and trends, evidence-only conversations ("Ask History"), scoped consent with immediate revocation, append-only access audit, integrity verification, and conservative FHIR R4 import/export. OpenAPI is served at `/openapi`; liveness at `/v1/health`.

## Architecture

```
Freighter wallet ──sign challenge──▶ Lifelyn API (this repo)
                                             │
                       ┌─────────────────────┼─────────────────────┐
                       ▼                     ▼                     ▼
                  PostgreSQL           Redis (BullMQ)        Object storage
                  (Prisma)             ingestion/reindex     (private, S3-compatible)
                       │                     │
                       ▼                     ▼
                  Lifelyn AI          Stellar signer service
              (evidence extraction,   (opaque refs/hashes only —
               citation-verified       never readable medical
               answers)                 content on-chain)
```

Every new endpoint carries Zod validation, an authorization check, safe error responses, OpenAPI docs, and an audit-event write where relevant — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Quick start

```bash
pnpm install --frozen-lockfile
cp .env.example .env   # fill every blank secret/service value
docker compose -f docker-compose.dev.yml up -d --wait   # Postgres/pgvector, Redis, private MinIO bucket
pnpm db:generate && pnpm db:deploy
pnpm dev            # HTTP service
pnpm dev:worker      # background workers, separate terminal
```

## Environment variables

See [`.env.example`](.env.example) for the full list. Notable constraints:

- `AI_SERVICE_JWT_SECRET` must exactly match the AI service's `SERVICE_JWT_SECRET`.
- Production must set `KMS_PROVIDER=external` and put signing/encryption material in a real secret manager — local development uses a built-in AES-GCM wrapper instead.
- `STELLAR_SIGNER_SERVICE_URL` points at a private transaction-building/signing service. This API never accepts or stores a raw Stellar seed.

## Testing

```bash
pnpm exec prisma validate && pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

CI additionally runs the real PostgreSQL integration suite. Public deployment further requires the cross-service integration suite, a backup/restore exercise, and an independent contract/security review — see the workspace-level `PRD_TRACEABILITY.md` and `BUILD_STATUS.md`.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Found a security issue? See [`SECURITY.md`](SECURITY.md) instead of opening a public issue.

## Contributors

<a href="https://github.com/Lifelyn456/Lifelyn-api/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Lifelyn456/Lifelyn-api" alt="Contributors" />
</a>
