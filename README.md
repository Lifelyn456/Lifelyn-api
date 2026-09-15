# Lifelyn API

NestJS/Fastify is the sole authorization and system-of-record boundary. Freighter wallet challenge signing is the only login mechanism. Provider verification and passkey MFA add clinical privileges; neither is an alternative login.

The live API implements wallet identity and profiles, passkey MFA, provider verification callbacks, encrypted record upload/finalization/source access, ingestion and reindex queues, normalized timeline review and trends, evidence-only conversations, scoped consent and immediate revocation, append-only access history, integrity verification, and conservative FHIR R4 import/export. OpenAPI is served at `/openapi`; process liveness is `/v1/health`.

Clinical operations fail closed when PostgreSQL, Redis, private object storage, the malware scanner, private AI service, secure Stellar signer, or required cryptographic keys are unavailable. No protected route returns fixture or synthetic product data.

## Local services

1. Copy `.env.example` to `.env` and fill every blank secret/service value.
2. Run `pnpm install --frozen-lockfile`.
3. Run `docker compose -f docker-compose.dev.yml up -d --wait`. The compose stack creates PostgreSQL/pgvector, Redis, and a private `lifelyn-records` MinIO bucket.
4. Run `pnpm db:generate && pnpm db:deploy`.
5. Start the HTTP service with `pnpm dev` and the workers with `pnpm dev:worker`.

`AI_SERVICE_JWT_SECRET` must exactly match the AI service's `SERVICE_JWT_SECRET`. Production must set `KMS_PROVIDER=external` and put signing/encryption material in its secret manager. `STELLAR_SIGNER_SERVICE_URL` is a private transaction-building/signing service; raw Stellar seeds are never accepted or stored by this API.

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before release. Public deployment additionally requires the cross-service integration suite, backup/restore exercise, independent contract/security review, and configured live infrastructure described in the workspace traceability report.
