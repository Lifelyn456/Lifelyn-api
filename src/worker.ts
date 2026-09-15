import "dotenv/config";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { validateIngestResult, type SourceKind } from "./common/ai-schemas.js";
import { DatabaseService } from "./common/database.service.js";
import { FieldCryptoService } from "./common/field-crypto.service.js";
import { AiClient } from "./integrations/ai-client.js";
import { StellarAdapter } from "./integrations/stellar.js";
import { EnvironmentKeyWrapper, MalwareScanner, ObjectStorageService } from "./modules/records/object-storage.service.js";

const url = process.env.REDIS_URL;
if (!url) throw new Error("REDIS_URL is required for workers");
const connection = new Redis(url, { maxRetriesPerRequest: null });
const database = new DatabaseService();
const fields = new FieldCryptoService();
const storage = new ObjectStorageService(new EnvironmentKeyWrapper(), new MalwareScanner());
const ai = new AiClient();
const stellar = new StellarAdapter();
const stellarConfirmQueue = new Queue("stellar-confirm", { connection });
async function confirmLater(txHash: string, targetType: string, targetId: string) {
  await stellarConfirmQueue.add("stellar-confirm", { txHash, targetType, targetId }, { jobId: `stellar-confirm-${txHash}`, delay: 5_000, attempts: 12, backoff: { type: "exponential", delay: 5_000 }, removeOnComplete: 1_000, removeOnFail: false });
}
const cleanupQueue = new Queue("cleanup-expired-links", { connection });
// Idempotent: upsertJobScheduler replaces any existing scheduler with this id rather than
// duplicating it, so re-running this on every worker boot is safe.
await cleanupQueue.upsertJobScheduler(
  "cleanup-expired-links-schedule",
  { every: 5 * 60_000 },
  { name: "cleanup-expired-links", opts: { removeOnComplete: 100, removeOnFail: false } },
);
async function ingest(recordVersionId: string, correlationId: string, replaceCandidates = false) {
  const db = database.client();
  const version = await db.recordVersion.findUnique({ where: { id: recordVersionId }, include: { record: { include: { patient: true, sourceProvider: true } }, jobs: true } });
  if (!version?.record.objectKey) throw new Error("RECORD_VERSION_NOT_FOUND");
  if (!replaceCandidates && version.jobs.some((job) => job.status === "COMPLETED")) return { status: "ALREADY_COMPLETED" };
  const sourceKind: SourceKind = version.record.sourceType === "PATIENT_ENTERED" ? "patient" : version.record.sourceProvider?.verificationStatus === "VERIFIED" ? "provider" : "import";
  await db.ingestionJob.updateMany({ where: { recordVersionId }, data: { status: "PROCESSING", attempt: { increment: 1 } } });
  await db.medicalRecord.update({ where: { id: version.recordId }, data: { status: "PROCESSING" } });
  const original = await storage.read(version.record.objectKey, { iv: Buffer.from(version.encryptionIv), tag: Buffer.from(version.encryptionTag), wrappedKey: Buffer.from(version.encryptionWrappedKey), keyRef: version.encryptionKeyRef, sha256: version.sha256 });
  try {
    const payload = { schema_version: "1.0", record_version_id: version.id, authorized_patient_id: version.record.patientId, mime_type: version.record.mimeType, document_base64: original.toString("base64"), source_kind: sourceKind };
    const raw = await (replaceCandidates ? ai.reindex(payload, correlationId) : ai.ingest(payload, correlationId));
    const { result, spanMap } = validateIngestResult(raw, version.id, sourceKind, process.env.AI_PIPELINE_VERSION?.trim() || "history-v1");
    await db.$transaction(async (tx) => {
      const protectedFingerprints = new Set<string>();
      if (replaceCandidates) {
        const linked = await tx.sourceCitation.findMany({ where: { recordVersionId: version.id }, select: { entityType: true, entityId: true, extractedTextHash: true } });
        const ids = (type: string) => [...new Set(linked.filter((item) => item.entityType === type).map((item) => item.entityId))];
        const eventIds = ids("MedicalEvent");
        const protectedEvents = eventIds.length ? await tx.medicalEvent.findMany({ where: { id: { in: eventIds }, reviewStatus: { in: ["ACCEPTED", "CORRECTED"] } }, select: { eventType: true, occurredAt: true, interpretation: true, id: true } }) : [];
        for (const fingerprint of protectedEvents.map((event) => {
          const value = event.interpretation && typeof event.interpretation === "object" && !Array.isArray(event.interpretation) ? event.interpretation as { display?: unknown } : {};
          const hashes = linked.filter((item) => item.entityType === "MedicalEvent" && item.entityId === event.id).map((item) => item.extractedTextHash).sort();
          return `${event.eventType}|${event.occurredAt.toISOString()}|${String(value.display ?? "")}|${hashes.join(",")}`;
        })) protectedFingerprints.add(fingerprint);
        const replaceableEvents = eventIds.length ? await tx.medicalEvent.findMany({ where: { id: { in: eventIds }, reviewStatus: { notIn: ["ACCEPTED", "CORRECTED"] } }, select: { id: true } }) : [];
        const replaceableEventIds = replaceableEvents.map((event) => event.id);
        const replaceableEntityIds = new Set([...replaceableEventIds, ...ids("Condition"), ...ids("MedicationStatement"), ...ids("Allergy"), ...ids("Observation"), ...ids("Encounter"), ...ids("Procedure"), ...ids("Immunization")]);
        if (replaceableEntityIds.size) await tx.sourceCitation.deleteMany({ where: { recordVersionId: version.id, entityId: { in: [...replaceableEntityIds] } } });
        if (replaceableEventIds.length) await tx.medicalEvent.deleteMany({ where: { id: { in: replaceableEventIds } } });
        if (ids("Condition").length) await tx.condition.deleteMany({ where: { id: { in: ids("Condition") } } });
        if (ids("MedicationStatement").length) await tx.medicationStatement.deleteMany({ where: { id: { in: ids("MedicationStatement") } } });
        if (ids("Allergy").length) await tx.allergy.deleteMany({ where: { id: { in: ids("Allergy") } } });
        if (ids("Observation").length) await tx.observation.deleteMany({ where: { id: { in: ids("Observation") } } });
        if (ids("Encounter").length) await tx.encounter.deleteMany({ where: { id: { in: ids("Encounter") } } });
        if (ids("Procedure").length) await tx.procedure.deleteMany({ where: { id: { in: ids("Procedure") } } });
        if (ids("Immunization").length) await tx.immunization.deleteMany({ where: { id: { in: ids("Immunization") } } });
        if (eventIds.length) await tx.medicalEvent.updateMany({ where: { id: { in: eventIds } }, data: { sourceKind, selfReported: sourceKind === "patient" } });
      }
      const persistCitations = async (entityType: string, entityId: string, sourceSpanIds: string[]) => {
        for (const spanId of sourceSpanIds) {
          const citation = spanMap.get(spanId);
          if (!citation || citation.recordVersionId !== version.id) throw new Error("INVALID_AI_CITATION");
          await tx.sourceCitation.create({ data: { entityType, entityId, recordVersionId: version.id, page: citation.page, charStart: citation.start, charEnd: citation.end, extractedTextHash: citation.textHash, spanTextEncrypted: fields.encrypt(citation.text) } });
        }
      };
      for (const event of result.events) {
        const citedHashes = event.source_span_ids.map((spanId) => spanMap.get(spanId)!.textHash).sort();
        const fingerprint = `${event.event_type}|${new Date(event.occurred_at).toISOString()}|${event.display}|${citedHashes.join(",")}`;
        if (replaceCandidates && protectedFingerprints.has(fingerprint)) continue;
        const created = await tx.medicalEvent.create({ data: { patientId: version.record.patientId, eventType: event.event_type, occurredAt: new Date(event.occurred_at), certainty: event.certainty, sourceKind: event.source_kind, selfReported: event.self_reported, interpretation: { display: event.display, recordVersionId: version.id, sourceSpanIds: event.source_span_ids }, reviewStatus: "PENDING_REVIEW" } });
        await persistCitations("MedicalEvent", created.id, event.source_span_ids);
      }
      for (const entity of result.entities) {
        const occurredAt = entity.occurred_at ? new Date(entity.occurred_at) : undefined;
        let entityId: string;
        if (entity.entity_type === "Condition") entityId = (await tx.condition.create({ data: { patientId: version.record.patientId, display: entity.name, onsetAt: occurredAt } })).id;
        else if (entity.entity_type === "MedicationStatement") entityId = (await tx.medicationStatement.create({ data: { patientId: version.record.patientId, medicationName: entity.name, status: entity.status, startAt: occurredAt } })).id;
        else if (entity.entity_type === "Allergy") entityId = (await tx.allergy.create({ data: { patientId: version.record.patientId, substance: entity.name, status: entity.status } })).id;
        else if (entity.entity_type === "Observation" && occurredAt) entityId = (await tx.observation.create({ data: { patientId: version.record.patientId, name: entity.name, valueNumeric: entity.value_numeric, valueText: entity.value_text, unit: entity.unit, observedAt: occurredAt } })).id;
        else if (entity.entity_type === "Encounter" && occurredAt) entityId = (await tx.encounter.create({ data: { patientId: version.record.patientId, encounterType: entity.name, startedAt: occurredAt } })).id;
        else if (entity.entity_type === "Procedure") entityId = (await tx.procedure.create({ data: { patientId: version.record.patientId, name: entity.name, performedAt: occurredAt } })).id;
        else if (entity.entity_type === "Immunization") entityId = (await tx.immunization.create({ data: { patientId: version.record.patientId, vaccineName: entity.name, administeredAt: occurredAt } })).id;
        else continue;
        await persistCitations(entity.entity_type, entityId, entity.source_span_ids);
      }
      await tx.ingestionJob.updateMany({ where: { recordVersionId }, data: { status: "COMPLETED", errorCode: null } });
      await tx.medicalRecord.update({ where: { id: version.recordId }, data: { status: "NEEDS_REVIEW" } });
    });
  } finally {
    original.fill(0);
  }
}

async function verifyIntegrity(recordVersionId: string) {
  const version = await database.client().recordVersion.findUnique({ where: { id: recordVersionId }, include: { record: true } });
  if (!version?.record.objectKey) throw new Error("RECORD_VERSION_NOT_FOUND");
  return storage.integrityCheck(version.record.objectKey, { iv: Buffer.from(version.encryptionIv), tag: Buffer.from(version.encryptionTag), wrappedKey: Buffer.from(version.encryptionWrappedKey), keyRef: version.encryptionKeyRef, sha256: version.sha256 });
}

const workers = [
  new Worker("record-ingest", async (job) => ingest(String(job.data.recordVersionId), String(job.data.correlationId)), { connection }),
  new Worker("record-reindex", async (job) => ingest(String(job.data.recordVersionId), String(job.data.correlationId), true), { connection }),
  new Worker("integrity-check", async (job) => verifyIntegrity(String(job.data.recordVersionId)), { connection }),
  new Worker("stellar-submit", async (job) => {
    const db = database.client();
    if (job.data.operation === "provider-status") {
      const provider = await db.providerProfile.findUnique({ where: { id: String(job.data.providerId) } });
      if (!provider?.stellarProviderRef || !provider.verificationMetadataHash) throw new Error("PROVIDER_NOT_READY");
      let txHash = provider.stellarTxHash;
      if (!txHash) {
        const registered = await stellar.registerProvider(provider.stellarProviderRef, provider.verificationMetadataHash, `stellar-provider-register:${provider.id}`);
        if (registered.status !== "SUCCESS") throw new Error("STELLAR_TRANSACTION_PENDING");
        txHash = registered.txHash;
      }
      const result = await stellar.setProviderStatus(provider.stellarProviderRef, Boolean(job.data.verified), String(job.data.idempotencyKey));
      if (result.status !== "SUCCESS") await confirmLater(result.txHash, "provider", provider.id);
      return db.providerProfile.update({ where: { id: provider.id }, data: { stellarTxHash: result.txHash || txHash } });
    }
    if (job.data.operation === "attest") {
      const attestation = await db.recordAttestation.findUnique({ where: { id: String(job.data.attestationId) }, include: { recordVersion: true } });
      const issuer = process.env.STELLAR_ATTESTATION_ISSUER_ADDRESS;
      if (!attestation || !issuer) throw new Error("ATTESTATION_NOT_READY");
      const result = await stellar.attest(attestation.stellarRecordRef, attestation.recordVersion.sha256, issuer, String(job.data.idempotencyKey));
      if (result.status !== "SUCCESS") await confirmLater(result.txHash, "attestation", attestation.id);
      return db.recordAttestation.update({ where: { id: attestation.id }, data: { stellarTxHash: result.txHash, status: result.status === "SUCCESS" ? "CONFIRMED" : "PENDING" } });
    }
    const grant = await db.consentGrant.findUnique({ where: { id: String(job.data.grantId) }, include: { patient: true } });
    if (!grant?.stellarRef) throw new Error("GRANT_NOT_FOUND");
    if (job.data.operation === "revoke") {
      const result = await stellar.revoke(grant.stellarRef, String(job.data.idempotencyKey));
      if (result.status !== "SUCCESS") await confirmLater(result.txHash, "grant-revoke", grant.id);
      return db.consentGrant.update({ where: { id: grant.id }, data: { stellarTxHash: result.txHash } });
    }
    if (grant.revokedAt || grant.expiresAt <= new Date() || !["PENDING_CHAIN", "CHAIN_FAILED"].includes(grant.status)) return { status: "SKIPPED_INACTIVE_GRANT", grantId: grant.id };
    const provider = await db.providerProfile.findUnique({ where: { id: grant.recipientId }, include: { user: true } });
    if (!provider) throw new Error("PROVIDER_NOT_FOUND");
    const result = await stellar.grant({ grantRef: grant.stellarRef, subjectRef: grant.patient.stellarSubjectRef, recipient: provider.user.authSubject, scopeHash: grant.scopeManifestHash, startsAt: Math.floor(grant.startsAt.getTime() / 1000), expiresAt: Math.floor(grant.expiresAt.getTime() / 1000) }, String(job.data.idempotencyKey));
    if (result.status !== "SUCCESS") await confirmLater(result.txHash, "grant", grant.id);
    return db.consentGrant.updateMany({ where: { id: grant.id, revokedAt: null, expiresAt: { gt: new Date() }, status: { in: ["PENDING_CHAIN", "CHAIN_FAILED"] } }, data: { stellarTxHash: result.txHash, status: result.status === "SUCCESS" ? "ACTIVE" : "PENDING_CHAIN" } });
  }, { connection }),
  new Worker("stellar-confirm", async (job) => {
    const status = await stellar.confirm(String(job.data.txHash));
    if (status === "PENDING") throw new Error("STELLAR_TRANSACTION_PENDING");
    if (status === "FAILED") throw new Error("STELLAR_TRANSACTION_FAILED");
    const db = database.client();
    if (job.data.targetType === "grant") return db.consentGrant.updateMany({ where: { id: String(job.data.targetId), revokedAt: null, expiresAt: { gt: new Date() }, status: "PENDING_CHAIN" }, data: { status: "ACTIVE" } });
    if (job.data.targetType === "attestation") return db.recordAttestation.update({ where: { id: String(job.data.targetId) }, data: { status: "CONFIRMED" } });
    return { confirmed: true, targetType: job.data.targetType, targetId: job.data.targetId };
  }, { connection }),
  new Worker("cleanup-expired-links", async () => database.client().consentGrant.updateMany({ where: { status: "ACTIVE", expiresAt: { lte: new Date() } }, data: { status: "EXPIRED" } }), { connection }),
];

for (const worker of workers) worker.on("failed", async (job, error) => {
  const terminal = Boolean(job && job.attemptsMade >= (job.opts.attempts ?? 1));
  const errorCode = error.message.replace(/[^A-Z0-9_]/gi, "_").slice(0, 100).toUpperCase();
  if (job?.queueName === "record-ingest" || job?.queueName === "record-reindex") {
    await database.client().ingestionJob.updateMany({ where: { recordVersionId: String(job.data.recordVersionId) }, data: { status: terminal ? "FAILED" : "RETRYING", errorCode } });
  }
  if (terminal && job?.queueName === "stellar-submit") {
    if (job.data.attestationId) await database.client().recordAttestation.updateMany({ where: { id: String(job.data.attestationId) }, data: { status: "FAILED" } });
    if (job.data.grantId && job.data.operation !== "revoke") await database.client().consentGrant.updateMany({ where: { id: String(job.data.grantId), revokedAt: null }, data: { status: "CHAIN_FAILED" } });
  }
  if (terminal && job?.queueName === "stellar-confirm") {
    if (job.data.targetType === "attestation") await database.client().recordAttestation.updateMany({ where: { id: String(job.data.targetId) }, data: { status: "FAILED" } });
    if (job.data.targetType === "grant") await database.client().consentGrant.updateMany({ where: { id: String(job.data.targetId), revokedAt: null }, data: { status: "CHAIN_FAILED" } });
  }
  console.error(JSON.stringify({ level: "error", event: "job_failed", queue: job?.queueName, jobId: job?.id, attempt: job?.attemptsMade, terminal, correlationId: job?.data.correlationId, errorCode }));
});

async function shutdown() {
  await Promise.all(workers.map((worker) => worker.close()));
  await stellarConfirmQueue.close();
  await cleanupQueue.close();
  await connection.quit();
  await database.onModuleDestroy();
}
process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
