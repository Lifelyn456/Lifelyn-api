# Security policy

Lifelyn is a healthcare-record system. This repository (the API) handles authorization, record storage, consent, and audit — it is the highest-value target in the workspace. It is **unaudited**. Do not point it at real patient data or treat it as compliant with HIPAA, GDPR, NDPR, or any other regime until an independent security review and the jurisdiction-specific legal review described in the root `BUILD_STATUS.md` are complete.

## Threat model

See the root-level `SECURITY.md` (`../SECURITY.md` from the workspace root) for the full threat model, controls, and incident-response runbook. Summary of what's in scope here: Freighter SEP-53 challenge/session handling, per-request owner/provider/consent/scope/time authorization, envelope encryption of records, malware scanning on upload, the API↔AI service boundary, and Stellar submission (opaque refs only, never readable medical content on-chain).

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security finding — this repo handles patient records.

- Preferred: use this repository's [GitHub Security Advisories](https://github.com/Lifelyn456/Lifelyn-api/security/advisories/new) ("Report a vulnerability" under the Security tab).
- Alternative: contact **@precious1joe** on Telegram with a clear description, reproduction steps, and impact. Never include real patient data, live credentials, or signed production transactions in a report.

We aim to acknowledge reports within 5 business days. Please give us reasonable time to remediate before any public disclosure.

## What's in scope

- Authorization bypass on any protected endpoint (records, timeline, ask, consent, audit, FHIR)
- Encryption or key-handling flaws
- Injection, deserialization, or SSRF in any controller
- Consent scope/expiry/revocation not enforced correctly
- Stellar submission leaking readable medical content on-chain

## What's out of scope

- Findings that require an already-compromised database or KMS
- Denial-of-service via resource exhaustion against free-tier hosting
- Issues already tracked in open GitHub issues, `PRD_TRACEABILITY.md`, or `BUILD_STATUS.md`
