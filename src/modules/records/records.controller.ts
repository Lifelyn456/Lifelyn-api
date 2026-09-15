import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, StreamableFile, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { WalletJwtGuard, type AuthedRequest } from "../../common/auth-context.js";
import { AuthorizationService } from "../../common/authorization.service.js";
import { DatabaseService } from "../../common/database.service.js";
import { IdentityService } from "../../common/identity.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import { ObjectStorageService } from "./object-storage.service.js";

const id = z.string().uuid();
const uploadSchema = z.object({ filename: z.string().trim().min(1).max(255), mimeType: z.enum(["application/pdf", "image/png", "image/jpeg"]), sizeBytes: z.number().int().positive().max(25 * 1024 * 1024), recordType: z.string().trim().min(1).max(80).default("OTHER"), sourceType: z.enum(["UPLOAD", "PATIENT_ENTERED"]).default("UPLOAD") }).strict();
const finalizeSchema = z.object({ recordId: id, objectKey: z.string().min(1).max(500) }).strict();

@Controller("v1/patients")
@ApiBearerAuth()
@UseGuards(WalletJwtGuard)
export class RecordsController {
  constructor(private readonly storage: ObjectStorageService, private readonly database: DatabaseService, private readonly identities: IdentityService, private readonly authorization: AuthorizationService, private readonly jobs: JobsService) {}

  @Post("me/records/upload-url")
  @ApiOperation({ summary: "Create a five-minute URL for a private staging upload" })
  async uploadUrl(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = uploadSchema.parse(body);
    const user = await this.identities.current(req);
    if (!user.patient) throw new BadRequestException("A patient profile is required.");
    await this.authorization.assert(req, user.patient.id, "create", "records", undefined, "record-upload");
    const record = await this.database.client().medicalRecord.create({ data: { patientId: user.patient.id, recordType: input.recordType, sourceType: input.sourceType, originalFilename: input.filename, mimeType: input.mimeType, declaredSizeBytes: input.sizeBytes } });
    const signed = await this.storage.createUploadUrl({ recordId: record.id, mimeType: input.mimeType });
    await this.database.client().medicalRecord.update({ where: { id: record.id }, data: { stagingObjectKey: signed.objectKey } });
    return { recordId: record.id, ...signed, next: "POST /v1/patients/me/records/finalize" };
  }

  @Post("me/records/finalize")
  @ApiOperation({ summary: "Scan, envelope-encrypt, hash, persist, and queue an uploaded original" })
  async finalize(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = finalizeSchema.parse(body);
    const user = await this.identities.current(req);
    if (!user.patient) throw new BadRequestException("A patient profile is required.");
    await this.authorization.assert(req, user.patient.id, "create", "records", input.recordId, "record-finalize");
    const record = await this.database.client().medicalRecord.findUnique({ where: { id: input.recordId } });
    if (!record || record.patientId !== user.patient.id || record.stagingObjectKey !== input.objectKey || record.status !== "PENDING_UPLOAD") throw new NotFoundException("Pending upload was not found.");
    const stored = await this.storage.finalize(input.objectKey, record.mimeType, record.declaredSizeBytes);
    const correlationId = req.id ?? randomUUID();
    const idempotencyKey = `record-ingest:${record.id}:1`;
    const result = await this.database.client().$transaction(async (tx) => {
      const version = await tx.recordVersion.create({ data: { recordId: record.id, versionNo: 1, sha256: stored.sha256, sizeBytes: record.declaredSizeBytes, objectVersionId: stored.objectVersionId, encryptionKeyRef: stored.keyRef, encryptionWrappedKey: Uint8Array.from(stored.wrappedKey), encryptionIv: Uint8Array.from(stored.iv), encryptionTag: Uint8Array.from(stored.tag) } });
      const attestation = await tx.recordAttestation.create({ data: { recordVersionId: version.id, attestationType: "CONTENT_INTEGRITY", stellarRecordRef: randomBytes(32).toString("hex") } });
      await tx.medicalRecord.update({ where: { id: record.id }, data: { objectKey: stored.objectKey, stagingObjectKey: null, status: "QUEUED" } });
      await tx.ingestionJob.create({ data: { recordVersionId: version.id, idempotencyKey, correlationId } });
      return { version, attestation };
    });
    await this.jobs.add("record-ingest", { recordVersionId: result.version.id, correlationId }, idempotencyKey);
    await this.jobs.add("stellar-submit", { operation: "attest", attestationId: result.attestation.id, correlationId }, `stellar-attest:${result.attestation.id}`);
    return { recordId: record.id, recordVersionId: result.version.id, status: "QUEUED", sha256: result.version.sha256 };
  }

  @Get(":patientId/records")
  async list(@Req() req: AuthedRequest, @Param("patientId") rawPatientId: string) {
    const patientId = await this.patientId(req, rawPatientId);
    await this.authorization.assert(req, patientId, "read", "records", undefined, "record-list");
    return this.database.client().medicalRecord.findMany({ where: { patientId }, select: { id: true, recordType: true, sourceType: true, originalFilename: true, mimeType: true, status: true, createdAt: true, versions: { select: { id: true, versionNo: true, sha256: true, sizeBytes: true, createdAt: true } } }, orderBy: { createdAt: "desc" } });
  }

  @Get(":patientId/records/:recordId")
  async detail(@Req() req: AuthedRequest, @Param("patientId") rawPatientId: string, @Param("recordId") rawRecordId: string) {
    const patientId = await this.patientId(req, rawPatientId);
    const recordId = id.parse(rawRecordId);
    await this.authorization.assert(req, patientId, "read", "records", recordId, "record-detail");
    const record = await this.database.client().medicalRecord.findFirst({ where: { id: recordId, patientId }, include: { versions: { select: { id: true, versionNo: true, sha256: true, sizeBytes: true, createdAt: true } } } });
    if (!record) throw new NotFoundException("Record was not found.");
    return { ...record, objectKey: undefined, stagingObjectKey: undefined, sourceUrl: `/v1/patients/${patientId}/records/${recordId}/source` };
  }

  @Get(":patientId/records/:recordId/source")
  async source(@Req() req: AuthedRequest, @Param("patientId") rawPatientId: string, @Param("recordId") rawRecordId: string) {
    const patientId = await this.patientId(req, rawPatientId);
    const recordId = id.parse(rawRecordId);
    await this.authorization.assert(req, patientId, "read", "records", recordId, "source-view");
    const record = await this.database.client().medicalRecord.findFirst({ where: { id: recordId, patientId }, include: { versions: { orderBy: { versionNo: "desc" }, take: 1 } } });
    const version = record?.versions[0];
    if (!record?.objectKey || !version) throw new NotFoundException("Record source was not found.");
    const content = await this.storage.read(record.objectKey, { iv: Buffer.from(version.encryptionIv), tag: Buffer.from(version.encryptionTag), wrappedKey: Buffer.from(version.encryptionWrappedKey), keyRef: version.encryptionKeyRef, sha256: version.sha256 });
    return new StreamableFile(content, { type: record.mimeType, disposition: `inline; filename="${record.originalFilename.replace(/["\\\r\n]/g, "_")}"` });
  }

  @Post(":patientId/records/:recordId/integrity-check")
  async integrity(@Req() req: AuthedRequest, @Param("patientId") rawPatientId: string, @Param("recordId") rawRecordId: string) {
    const patientId = await this.patientId(req, rawPatientId);
    const recordId = id.parse(rawRecordId);
    await this.authorization.assert(req, patientId, "integrity-check", "records", recordId);
    const record = await this.database.client().medicalRecord.findFirst({ where: { id: recordId, patientId }, include: { versions: { orderBy: { versionNo: "desc" }, take: 1 } } });
    const version = record?.versions[0];
    if (!record?.objectKey || !version) throw new NotFoundException("Record was not found.");
    return this.storage.integrityCheck(record.objectKey, { iv: Buffer.from(version.encryptionIv), tag: Buffer.from(version.encryptionTag), wrappedKey: Buffer.from(version.encryptionWrappedKey), keyRef: version.encryptionKeyRef, sha256: version.sha256 });
  }

  @Post(":patientId/records/:recordId/reprocess")
  async reprocess(@Req() req: AuthedRequest, @Param("patientId") rawPatientId: string, @Param("recordId") rawRecordId: string) {
    const patientId = await this.patientId(req, rawPatientId);
    const recordId = id.parse(rawRecordId);
    await this.authorization.assert(req, patientId, "reprocess", "records", recordId);
    const record = await this.database.client().medicalRecord.findFirst({ where: { id: recordId, patientId }, include: { versions: { orderBy: { versionNo: "desc" }, take: 1 } } });
    if (!record?.versions[0]) throw new NotFoundException("Record was not found.");
    const pipelineVersion = process.env.AI_PIPELINE_VERSION?.trim() || "history-v1";
    const key = `record-reindex:${record.versions[0].id}:${pipelineVersion}`;
    await this.jobs.add("record-reindex", { recordVersionId: record.versions[0].id, correlationId: req.id }, key);
    return { status: "QUEUED", idempotencyKey: key };
  }

  private async patientId(req: AuthedRequest, value: string) {
    if (value !== "me") return id.parse(value);
    const user = await this.identities.current(req);
    if (!user.patient) throw new BadRequestException("A patient profile is required.");
    return user.patient.id;
  }
}
