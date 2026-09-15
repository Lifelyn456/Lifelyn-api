import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Patch, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { z } from "zod";
import { WalletJwtGuard, type AuthedRequest } from "../../common/auth-context.js";
import { AuthorizationService } from "../../common/authorization.service.js";
import { DatabaseService } from "../../common/database.service.js";
import { IdentityService } from "../../common/identity.service.js";

const uuid = z.string().uuid();
const correctionSchema = z.object({ reason: z.string().trim().min(1).max(500), fields: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])), reviewStatus: z.enum(["ACCEPTED", "CORRECTED", "REJECTED"]) }).strict();

@Controller("v1/patients")
@ApiBearerAuth()
@UseGuards(WalletJwtGuard)
export class TimelineController {
  constructor(private readonly database: DatabaseService, private readonly identities: IdentityService, private readonly authorization: AuthorizationService) {}

  @Get(":patientId/timeline")
  @ApiOperation({ summary: "Read authorized structured events with immutable provenance references" })
  async timeline(@Req() req: AuthedRequest, @Param("patientId") raw: string) {
    const patientId = await this.resolve(req, raw);
    await this.authorization.assert(req, patientId, "read", "timeline", undefined, "timeline");
    const events = await this.database.client().medicalEvent.findMany({ where: { patientId, reviewStatus: { in: ["ACCEPTED", "CORRECTED", "PENDING_REVIEW"] } }, orderBy: { occurredAt: "desc" } });
    const citations = events.length ? await this.database.client().sourceCitation.findMany({ where: { entityType: "MedicalEvent", entityId: { in: events.map((event) => event.id) } }, select: { id: true, entityId: true, recordVersionId: true, page: true, section: true, charStart: true, charEnd: true, extractedTextHash: true, recordVersion: { select: { recordId: true } } } }) : [];
    return events.map((event) => ({ ...event, citations: citations.filter((citation) => citation.entityId === event.id).map(({ recordVersion, ...citation }) => ({ ...citation, recordId: recordVersion.recordId })) }));
  }

  @Get(":patientId/observations/trends")
  async trends(@Req() req: AuthedRequest, @Param("patientId") raw: string) {
    const patientId = await this.resolve(req, raw);
    await this.authorization.assert(req, patientId, "read", "observations", undefined, "observation-trends");
    const rows = await this.database.client().observation.findMany({ where: { patientId, reviewStatus: { in: ["ACCEPTED", "CORRECTED"] } }, orderBy: [{ name: "asc" }, { observedAt: "asc" }] });
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) grouped.set(row.name, [...(grouped.get(row.name) ?? []), row]);
    return [...grouped.entries()].map(([name, values]) => ({ name, values: values.map((row) => ({ valueNumeric: row.valueNumeric?.toString(), valueText: row.valueText, unit: row.unit, refLow: row.refLow?.toString(), refHigh: row.refHigh?.toString(), observedAt: row.observedAt })) }));
  }

  @Patch("me/events/:eventId")
  @ApiOperation({ summary: "Attach patient correction metadata without mutating original extraction evidence" })
  async correct(@Req() req: AuthedRequest, @Param("eventId") rawId: string, @Body() body: unknown) {
    const user = await this.identities.current(req);
    if (!user.patient) throw new BadRequestException("A patient profile is required.");
    await this.authorization.assert(req, user.patient.id, "correct", "timeline", undefined, "timeline-review");
    const event = await this.database.client().medicalEvent.findFirst({ where: { id: uuid.parse(rawId), patientId: user.patient.id } });
    if (!event) throw new NotFoundException("Timeline event was not found.");
    const correction = correctionSchema.parse(body);
    return this.database.client().$transaction(async (tx) => {
      const eventCitations = await tx.sourceCitation.findMany({ where: { entityType: "MedicalEvent", entityId: event.id }, select: { recordVersionId: true, page: true, charStart: true, charEnd: true, extractedTextHash: true } });
      const related = eventCitations.length ? await tx.sourceCitation.findMany({ where: { entityType: { in: ["Condition", "MedicationStatement", "Allergy", "Observation", "Encounter", "Procedure", "Immunization"] }, OR: eventCitations.map((citation) => ({ recordVersionId: citation.recordVersionId, page: citation.page, charStart: citation.charStart, charEnd: citation.charEnd, extractedTextHash: citation.extractedTextHash })) }, select: { entityType: true, entityId: true } }) : [];
      const ids = (type: string) => [...new Set(related.filter((item) => item.entityType === type).map((item) => item.entityId))];
      const normalizedStatus = correction.reviewStatus === "CORRECTED" ? "REJECTED" : correction.reviewStatus;
      await Promise.all([
        ids("Condition").length ? tx.condition.updateMany({ where: { id: { in: ids("Condition") }, patientId: user.patient!.id }, data: { reviewStatus: normalizedStatus } }) : undefined,
        ids("MedicationStatement").length ? tx.medicationStatement.updateMany({ where: { id: { in: ids("MedicationStatement") }, patientId: user.patient!.id }, data: { reviewStatus: normalizedStatus } }) : undefined,
        ids("Allergy").length ? tx.allergy.updateMany({ where: { id: { in: ids("Allergy") }, patientId: user.patient!.id }, data: { reviewStatus: normalizedStatus } }) : undefined,
        ids("Observation").length ? tx.observation.updateMany({ where: { id: { in: ids("Observation") }, patientId: user.patient!.id }, data: { reviewStatus: normalizedStatus } }) : undefined,
        ids("Encounter").length ? tx.encounter.updateMany({ where: { id: { in: ids("Encounter") }, patientId: user.patient!.id }, data: { reviewStatus: normalizedStatus } }) : undefined,
        ids("Procedure").length ? tx.procedure.updateMany({ where: { id: { in: ids("Procedure") }, patientId: user.patient!.id }, data: { reviewStatus: normalizedStatus } }) : undefined,
        ids("Immunization").length ? tx.immunization.updateMany({ where: { id: { in: ids("Immunization") }, patientId: user.patient!.id }, data: { reviewStatus: normalizedStatus } }) : undefined,
      ]);
      return tx.medicalEvent.update({ where: { id: event.id }, data: { correction: { ...correction, correctedAt: new Date().toISOString(), correctedBy: user.id }, reviewStatus: correction.reviewStatus } });
    });
  }

  private async resolve(req: AuthedRequest, value: string) {
    if (value !== "me") return uuid.parse(value);
    const user = await this.identities.current(req);
    if (!user.patient) throw new BadRequestException("A patient profile is required.");
    return user.patient.id;
  }
}
