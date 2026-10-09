# Stellar signer service

The API never holds a Stellar secret key. Every on-chain write (consent grant and revoke, provider registration and status, record attestation) goes to this private service, which holds the only signing key. It lives in this repository as a separate process (`src/signer/`), the same way the background worker does.

```text
API worker ──HTTPS + bearer token──▶ signer ──signed Soroban transaction──▶ Stellar RPC
(StellarAdapter)                       │
                                       └─ holds the key, allowlists contracts and methods
```

## What it guarantees

| Property | How |
| --- | --- |
| Only the API can call it | Every route except `/healthz` needs `Authorization: Bearer <SIGNER_AUTH_TOKEN>`, compared in constant time |
| It can only do what the product needs | It signs calls to the contracts it was configured with, and only the methods in `src/signer/contracts.ts` (`grant`, `revoke`, `register`, `set_status`, `attest`, `record_receipt`). Constructors, upgrades and unknown methods are refused |
| A leaked token cannot redirect it | The RPC URL and network come from the signer's own configuration. A request that names another network is refused, and a request-supplied `rpcUrl` is ignored |
| Arguments are validated, not trusted | References are exactly 64 hex characters (`BytesN<32>`), addresses are valid Stellar addresses, timestamps are `u64`. Unknown or missing arguments are refused |
| It cannot be made to sign for someone else | `authority` and `issuer` must equal the signer's own address, because only its key can authorize them |
| A retry never signs twice | Each request carries an `Idempotency-Key`. A repeat returns the first result. Reusing a key for a different operation is a `409` |
| No sequence-number clashes | One transaction is built, signed and submitted at a time |
| Contract rejections cost nothing | The transaction is simulated first. A call the contract would reject (a duplicate grant, say) is refused before anything is signed |
| Secrets stay out of logs | The authorization header is redacted, errors are generic, and the key is never logged. Only the public address is printed at startup |

## Running it

```bash
pnpm build
STELLAR_NETWORK=testnet \
STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
STELLAR_CONSENT_CONTRACT_ID=C... STELLAR_PROVIDER_CONTRACT_ID=C... \
STELLAR_RECORD_ATTESTATION_CONTRACT_ID=C... \
SIGNER_AUTH_TOKEN=<at least 32 random bytes> \
STELLAR_SIGNER_SECRET_FILE=/run/secrets/stellar_signer_seed \
pnpm start:signer
```

Point the API at it with `STELLAR_SIGNER_SERVICE_URL=http://<signer-host>:8787` and `STELLAR_SIGNER_SERVICE_TOKEN` equal to `SIGNER_AUTH_TOKEN`. The signer reads a `.env` in its working directory the same way the API does. Variables already in the environment win.

| Variable | Required | Meaning |
| --- | --- | --- |
| `STELLAR_NETWORK` | yes | `testnet`, `mainnet` or `local` |
| `STELLAR_RPC_URL` | yes | Soroban RPC. HTTPS, except on the local network |
| `STELLAR_*_CONTRACT_ID` | at least one | `CONSENT`, `PROVIDER`, `RECORD_ATTESTATION`, `ACCESS_RECEIPT`. Only these contracts are ever called |
| `SIGNER_AUTH_TOKEN` | yes | Bearer token, at least 32 bytes |
| `STELLAR_SIGNER_SECRET_FILE` | one of the two | Path to a mounted secret holding the seed. Required in production |
| `STELLAR_SIGNER_SECRET` | one of the two | The seed inline. Development only; refused when `NODE_ENV=production` |
| `SIGNER_STATE_FILE` | no | JSON-lines file that keeps idempotency records across restarts. Use a persistent volume in production |
| `SIGNER_HOST`, `SIGNER_PORT` | no | Default `127.0.0.1:8787`. Keep it on a private network |
| `SIGNER_CONFIRM_WAIT_MS` | no | How long a submit waits for the ledger before answering `PENDING`. Default 10000, maximum 50000 |

## HTTP contract

This is exactly what `src/integrations/stellar.ts` sends and expects.

```text
POST /                              Authorization: Bearer ...   Idempotency-Key: <8-200 safe characters>
  { "network": "testnet", "rpcUrl": "...", "contractId": "C...", "method": "grant", "args": { ... } }
  -> 200 { "txHash": "<64 hex>", "status": "PENDING" | "SUCCESS" | "FAILED" }

GET /v1/transactions/:txHash        Authorization: Bearer ...
  -> 200 { "status": "PENDING" | "SUCCESS" | "FAILED" }

GET /healthz                        (no authentication)
  -> 200 { "status": "ok" }
```

Errors are `{ "error": { "code": "...", "message": "..." } }`:

| Status | Codes |
| --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_HASH` |
| 401 | `UNAUTHORIZED` |
| 409 | `IDEMPOTENCY_CONFLICT` |
| 413 / 429 | `TOO_LARGE` (over 16 KiB), `RATE_LIMITED` (over 120 requests a minute) |
| 422 | `CONTRACT_NOT_ALLOWED`, `METHOD_NOT_ALLOWED`, `NETWORK_MISMATCH`, `INVALID_ARGUMENT`, `CONTRACT_REJECTED` |
| 502 / 503 | `SUBMISSION_REJECTED`, `RPC_BUSY`, `RPC_UNAVAILABLE` |

### Argument mapping

The API uses camelCase names. The signer maps them to the contract's parameters in the contract's positional order.

| Contract call | API arguments | Notes |
| --- | --- | --- |
| `ConsentRegistry.grant` | `grantRef`, `subjectRef`, `recipient`, `scopeHash`, `startsAt`, `expiresAt` | The contract also needs a `grantor`. The signer supplies its own address. See the design decision below |
| `ConsentRegistry.revoke` | `grantRef` | |
| `ProviderRegistry.register` | `providerRef`, `authority`, `metadataHash` | `authority` must be the signer's address |
| `ProviderRegistry.set_status` | `providerRef`, `verified` | `verified` is `true` or `false` |
| `RecordAttestationRegistry.attest` | `recordRef`, `contentHash`, `issuer` | `issuer` must be the signer's address |
| `AccessReceiptRegistry.record_receipt` | `grantRef`, `accessRef`, `purposeHash` | The API does not send this yet |

## Design decisions and limits

- **The signer is the on-chain grantor.** `ConsentRegistry.grant` calls `grantor.require_auth()`. The patient's wallet is used to sign in, but it does not sign each on-chain write. The API checks the patient's authorization, and the signer records the grant as the grantor of record. Only opaque references and hashes go on-chain. Moving to patient-signed grants is a larger change that needs Freighter signing in the web app, and it is not done.
- **One key, held by whoever runs the signer.** Production should mount the seed from a secret manager (`STELLAR_SIGNER_SECRET_FILE`). Signing through an HSM or KMS, so the seed never reaches this process, is not implemented. A leaked token still cannot make the signer sign outside its allowlist, but a leaked seed can.
- **Idempotency records are per signer.** Without `SIGNER_STATE_FILE` they are lost on restart. The contracts reject duplicate grants, attestations and receipts, so a repeat fails safely, but use the state file.
- **Not deployed yet.** The code is finished and tested. Running it on hosted infrastructure and pointing the live API at it is an operator step.

## Verification

- **Unit tests** (`test/signer-*.test.ts`) cover argument encoding, every refusal listed above, idempotency (including across a restart), sequential signing, the HTTP layer and configuration validation. They use a fake RPC and synthetic data.
- **Stellar Testnet, 9 October 2026.** `pnpm smoke:signer` drove the signer through the API's own `StellarAdapter` against freshly deployed copies of the contracts, using a throwaway funded key. A consent grant confirmed and `is_active` read `true` on-chain. A retry with the same idempotency key returned the same transaction. A revoke confirmed and `is_active` read `false`. Provider registration, status change and a record attestation also confirmed. A second attestation for the same record was refused, a call to an unlisted contract was refused, and a request without the token got `401`.

| Operation | Transaction |
| --- | --- |
| Grant | [`acd7ba75…07db9`](https://stellar.expert/explorer/testnet/tx/acd7ba7573d11a1a0e13dd1fa6eac4345cd73e4c09a193b25c4ea3ae11a07db9) |
| Revoke | [`4246db33…f860f`](https://stellar.expert/explorer/testnet/tx/4246db33be3e8b87a225942545135590eaa759ea7d368b33229e64ec574f860f) |
| Provider register | [`3b7c6c60…4be80`](https://stellar.expert/explorer/testnet/tx/3b7c6c600c27d20b351029bcd47a16bab6208fa573ae2b49ca13250d9694be80) |
| Provider set status | [`2e985611…e59e`](https://stellar.expert/explorer/testnet/tx/2e985611f5c5269bf6df43a0bd2056de286f83a55d72454c073c030f117be59e) |
| Attestation | [`06f50d6b…442a3`](https://stellar.expert/explorer/testnet/tx/06f50d6b69e0a35b3334d514ebfbb440395345d667799be7e2cebcb3e32442a3) |

Testnet is reset from time to time, so these links may stop resolving.
