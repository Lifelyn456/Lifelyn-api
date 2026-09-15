import { BadGatewayException, BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { createHash } from "node:crypto";
import { z } from "zod";
import { WalletJwtGuard, type AuthedRequest } from "../../common/auth-context.js";
import { AuthorizationService } from "../../common/authorization.service.js";
import { DatabaseService } from "../../common/database.service.js";
import { FieldCryptoService } from "../../common/field-crypto.service.js";
import { IdentityService } from "../../common/identity.service.js";
import { AiClient } from "../../integrations/ai-client.js";
import { RequiresAuthorization } from "../../common/authorization.decorators.js";

const uuid = z.string().uuid();
const conversationSchema = z.object({ purpose: z.string().trim().min(1).max(300) }).strict();
const messageSchema = z.object({ question: z.string().trim().min(1).max(2_000) }).strict();
const aiResponse = z.object({ schema_version: z.literal("1.0"), answer: z.string().min(1).max(20_000), insufficient_evidence: z.boolean(), conflicts: z.array(z.string().max(1_000)).max(20), safety_notice: z.literal("This is a record summary, not a diagnosis or prescription."), claims: z.array(z.object({ text: z.string().min(1).max(500), support_status: z.literal("SUPPORTED"), occurred_at: z.string().datetime().nullable(), source_kind: z.enum(["provider", "patient", "import"]).nullable(), fact_id: z.string().max(100).nullable(), provenance: z.enum(["record", "patient-correction"]), citations: z.array(z.object({ record_version_id: z.string().uuid(), page: z.number().int().positive(), span_id: z.string().length(32), relevance_score: z.number().min(0).max(1) }).strict()).min(1).max(10) }).strict()).max(50) }).strict();
const insufficientAnswers = new Set(["This service summarizes recorded history only. Diagnosis and treatment decisions require clinical judgment.", "There is not enough authorized evidence in the provided records to answer that question."]);

@Controller("v1/patients/:patientId/conversations")
@ApiBearerAuth()
@UseGuards(WalletJwtGuard)
export class AskController {
  constructor(private readonly database: DatabaseService, private readonly identities: IdentityService, private readonly authorization: AuthorizationService, private readonly fields: FieldCryptoService, private readonly ai: AiClient) {}

  @Post()
  @RequiresAuthorization()
  @ApiOperation({ summary: "Create an authorized patient-history conversation" })
  async create(@Req() req: AuthedRequest, @Param("patientId") raw: string, @Body() body: unknown) {
    const patientId = await this.resolve(req, raw);
    const input = conversationSchema.parse(body);
    const access = await this.authorization.assert(req, patientId, "ask", "history", undefined, input.purpose);
    return this.database.client().aiConversation.create({ data: { patientId, actorUserId: access.user.id, purpose: input.purpose } });
  }

  @Post(":conversationId/messages")
  @RequiresAuthorization()
  @ApiOperation({ summary: "Ask only against authorized, cited patient evidence" })
  async message(@Req() req: AuthedRequest, @Param("patientId") raw: string, @Param("conversationId") conversationRaw: string, @Body() body: unknown) {
    const patientId = await this.resolve(req, raw);
    const conversationId = uuid.parse(conversationRaw);
    const input = messageSchema.parse(body);
    const access = await this.authorization.assert(req, patientId, "ask", "history", undefined, "conversation-message");
    const conversation = await this.database.client().aiConversation.findFirst({ where: { id: conversationId, patientId } });
    if (!conversation) throw new NotFoundException("Conversation was not found.");
    if (conversation.actorUserId !== access.user.id) throw new NotFoundException("Conversation was not found.");
    const allowedRecordIds = access.user.patient || access.grants.some((grant) => !grant.scope.recordIds)
      ? undefined
      : [...new Set(access.grants.flatMap((grant) => grant.scope.recordIds ?? []))];
    const versions = await this.database.client().recordVersion.findMany({ where: { record: { patientId, ...(allowedRecordIds ? { id: { in: allowedRecordIds } } : {}) } }, select: { id: true, recordId: true } });
    const allowedVersions = new Set(versions.map((version) => version.id));
    const events = await this.database.client().medicalEvent.findMany({ where: { patientId, reviewStatus: { in: ["ACCEPTED", "CORRECTED"] } }, select: { id: true, eventType: true, occurredAt: true, sourceKind: true, interpretation: true, correction: true, reviewStatus: true }, orderBy: { occurredAt: "desc" } });
    const eventIds = events.map((event) => event.id);
    const sourceKinds = new Map(events.map((event) => [event.id, event.sourceKind]));
    const citations = await this.database.client().sourceCitation.findMany({ where: { entityType: "MedicalEvent", entityId: { in: eventIds }, recordVersionId: { in: [...allowedVersions] }, spanTextEncrypted: { not: null } }, take: 500 });
    const evidence = citations.map((citation) => ({ record_version_id: citation.recordVersionId, page: citation.page ?? 1, start: citation.charStart ?? 0, end: citation.charEnd ?? 1, text: this.fields.decrypt(citation.spanTextEncrypted!), text_hash: citation.extractedTextHash, source_kind: sourceKinds.get(citation.entityId) === "patient" ? "patient" as const : sourceKinds.get(citation.entityId) === "provider" ? "provider" as const : "import" as const }));
    const evidenceIndex = new Map(evidence.map((span) => {
      if (span.end <= span.start || createHash("sha256").update(span.text).digest("hex") !== span.text_hash) throw new BadGatewayException("Stored evidence failed integrity validation.");
      const spanId = createHash("sha256").update(`${span.record_version_id}:${span.page}:${span.start}:${span.end}:${span.text_hash}`).digest("hex").slice(0, 32);
      return [spanId, span] as const;
    }));
    const structuredFacts = events.flatMap((event) => {
      const value = event.interpretation && typeof event.interpretation === "object" && !Array.isArray(event.interpretation) ? event.interpretation as { display?: unknown } : {};
      const correction = event.correction && typeof event.correction === "object" && !Array.isArray(event.correction) ? event.correction as { fields?: { display?: unknown } } : {};
      const correctedDisplay = event.reviewStatus === "CORRECTED" && typeof correction.fields?.display === "string" ? correction.fields.display.trim() : "";
      const display = correctedDisplay || (typeof value.display === "string" ? value.display.trim() : "");
      const sourceSpanIds = citations.filter((citation) => citation.entityId === event.id).map((citation) => createHash("sha256").update(`${citation.recordVersionId}:${citation.page ?? 1}:${citation.charStart ?? 0}:${citation.charEnd ?? 1}:${citation.extractedTextHash}`).digest("hex").slice(0, 32));
      const sourceKind = correctedDisplay ? "patient" as const : event.sourceKind === "patient" ? "patient" as const : event.sourceKind === "provider" ? "provider" as const : "import" as const;
      return display && sourceSpanIds.length ? [{ fact_id: event.id, fact_type: event.eventType, text: display, occurred_at: event.occurredAt.toISOString(), source_kind: sourceKind, source_span_ids: sourceSpanIds, patient_corrected: Boolean(correctedDisplay) }] : [];
    });
    const response = allowedVersions.size
      ? aiResponse.parse(await this.ai.query({ schema_version: "1.0", authorized_patient_id: patientId, question: input.question, authorized_record_version_ids: [...allowedVersions], evidence, structured_facts: structuredFacts }, req.id ?? crypto.randomUUID()))
      : aiResponse.parse({ schema_version: "1.0", answer: "There is not enough authorized evidence in the provided records to answer that question.", insufficient_evidence: true, conflicts: [], safety_notice: "This is a record summary, not a diagnosis or prescription.", claims: [] });
    const expectedAnswer = response.claims.map((claim) => claim.occurred_at ? `${claim.occurred_at.slice(0, 10)}: ${claim.text}` : claim.text).join("\n");
    if (response.insufficient_evidence ? response.claims.length !== 0 || !insufficientAnswers.has(response.answer) : response.claims.length === 0 || response.answer !== expectedAnswer) throw new BadGatewayException("The evidence service returned an unsupported answer.");
    const structuredFactById = new Map(structuredFacts.map((fact) => [fact.fact_id, fact]));
    for (const claim of response.claims) {
      const isSelfReported = claim.text.startsWith("Self-reported: ");
      const isPatientCorrection = claim.text.startsWith("Patient-corrected: ");
      const claimText = claim.text.replace(/^Self-reported: /, "").replace(/^Patient-corrected: /, "").trim();
      const claimSpanIds = claim.citations.map((citation) => citation.span_id).sort();
      const fact = claim.fact_id ? structuredFactById.get(claim.fact_id) : undefined;
      for (const citation of claim.citations) {
        const span = evidenceIndex.get(citation.span_id);
        if (!span || span.record_version_id !== citation.record_version_id || span.page !== citation.page) throw new BadGatewayException("The evidence service returned an invalid citation.");
        if (!isPatientCorrection && ((span.source_kind === "patient") !== isSelfReported || (claim.source_kind && span.source_kind !== claim.source_kind))) throw new BadGatewayException("The evidence service returned invalid source attribution.");
        if (!isPatientCorrection && !span.text.split(/\s+/).join(" ").includes(claimText)) throw new BadGatewayException("The evidence service returned an unsupported claim.");
      }
      if ((claim.occurred_at === null) !== (claim.source_kind === null)) throw new BadGatewayException("The evidence service returned incomplete structured provenance.");
      if (claim.occurred_at && claim.source_kind && (!fact || fact.occurred_at !== new Date(claim.occurred_at).toISOString() || fact.source_kind !== claim.source_kind || fact.text !== claimText || [...fact.source_span_ids].sort().join(",") !== claimSpanIds.join(",") || fact.patient_corrected !== (claim.provenance === "patient-correction") || isPatientCorrection !== fact.patient_corrected)) throw new BadGatewayException("The evidence service returned unsupported structured provenance.");
      if (!claim.occurred_at && (claim.fact_id !== null || claim.provenance !== "record" || isPatientCorrection)) throw new BadGatewayException("The evidence service returned invalid claim provenance.");
    }
    await this.database.client().$transaction(async (tx) => {
      await tx.aiMessage.create({ data: { conversationId, role: "user", textRedacted: "[Patient-history question redacted]" } });
      const assistant = await tx.aiMessage.create({ data: { conversationId, role: "assistant", textRedacted: "[Assistant answer redacted; claims and citations retained]" } });
      for (const claim of response.claims) {
        const stored = await tx.aiClaim.create({ data: { messageId: assistant.id, claimText: claim.occurred_at ? `${claim.occurred_at.slice(0, 10)}: ${claim.text}` : claim.text, supportStatus: claim.support_status } });
        await tx.aiCitation.createMany({ data: claim.citations.map((citation) => ({ claimId: stored.id, recordVersionId: citation.record_version_id, page: citation.page, spanRef: citation.span_id, relevanceScore: citation.relevance_score })) });
      }
    });
    const recordIds = new Map(versions.map((version) => [version.id, version.recordId]));
    return { ...response, claims: response.claims.map((claim) => ({ ...claim, citations: claim.citations.map((citation) => ({ ...citation, record_id: recordIds.get(citation.record_version_id) })) })) };
  }

  @Get(":conversationId/messages")
  @RequiresAuthorization()
  async messages(@Req() req: AuthedRequest, @Param("patientId") raw: string, @Param("conversationId") conversationRaw: string) {
    const patientId = await this.resolve(req, raw);
    const access = await this.authorization.assert(req, patientId, "ask", "history", undefined, "conversation-history");
    const conversation = await this.database.client().aiConversation.findFirst({ where: { id: uuid.parse(conversationRaw), patientId, actorUserId: access.user.id } });
    if (!conversation) throw new NotFoundException("Conversation was not found.");
    return this.database.client().aiMessage.findMany({ where: { conversationId: conversation.id }, include: { claims: { include: { citations: true } } }, orderBy: { createdAt: "asc" } });
  }

  private async resolve(req: AuthedRequest, value: string) {
    if (value !== "me") return uuid.parse(value);
    const user = await this.identities.current(req);
    if (!user.patient) throw new BadRequestException("A patient profile is required.");
    return user.patient.id;
  }
}
