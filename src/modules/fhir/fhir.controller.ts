import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WalletJwtGuard, type AuthedRequest } from "../../common/auth-context.js";
import { AuthorizationService } from "../../common/authorization.service.js";
import { DatabaseService } from "../../common/database.service.js";
import { IdentityService } from "../../common/identity.service.js";
import { validate_bundle } from "./fhir.mapper.js";
import { RequiresAuthorization } from "../../common/authorization.decorators.js";

const uuid = z.string().uuid();
type Resource = Record<string, unknown>;
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const date = (value: unknown) => { const valueText = text(value); return valueText && !Number.isNaN(Date.parse(valueText)) ? new Date(valueText) : undefined; };
const codingDisplay = (value: unknown) => {
  const concept = value as { text?: unknown; coding?: Array<{ display?: unknown; code?: unknown }> } | undefined;
  return text(concept?.text) ?? text(concept?.coding?.[0]?.display) ?? text(concept?.coding?.[0]?.code) ?? "Unspecified";
};

@Controller("v1/patients")
@ApiBearerAuth()
@UseGuards(WalletJwtGuard)
export class FhirController {
  constructor(private readonly database: DatabaseService, private readonly identities: IdentityService, private readonly authorization: AuthorizationService) {}

  @Post("me/fhir/import")
  @RequiresAuthorization()
  @ApiOperation({ summary: "Persist a conservative FHIR R4 import with original versioned payload provenance" })
  async import(@Req() req: AuthedRequest, @Body() body: unknown) {
    const user = await this.identities.current(req);
    if (!user.patient) throw new BadRequestException("A patient profile is required.");
    await this.authorization.assert(req, user.patient.id, "create", "fhir", undefined, "fhir-import");
    let resources: ReturnType<typeof validate_bundle>;
    try { resources = validate_bundle(body); }
    catch { throw new BadRequestException("FHIR payload validation failed."); }
    await this.database.client().$transaction(async (tx) => {
      for (const item of resources) {
        const resource = item.originalPayload as Resource;
        let internalType = String(item.resourceType);
        let internalId = user.patient!.id;
        if (item.resourceType === "Condition") {
          const created = await tx.condition.create({ data: { patientId: user.patient!.id, display: codingDisplay(resource.code), onsetAt: date(resource.onsetDateTime), resolvedAt: date(resource.abatementDateTime), reviewStatus: "ACCEPTED" } }); internalId = created.id;
        } else if (item.resourceType === "AllergyIntolerance") {
          const created = await tx.allergy.create({ data: { patientId: user.patient!.id, substance: codingDisplay(resource.code), status: text((resource.clinicalStatus as { text?: unknown })?.text) ?? "unknown", reviewStatus: "ACCEPTED" } }); internalId = created.id;
        } else if (item.resourceType === "MedicationRequest" || item.resourceType === "MedicationStatement") {
          const created = await tx.medicationStatement.create({ data: { patientId: user.patient!.id, medicationName: codingDisplay(resource.medicationCodeableConcept), status: text(resource.status) ?? "unknown", startAt: date((resource.effectivePeriod as { start?: unknown })?.start), endAt: date((resource.effectivePeriod as { end?: unknown })?.end), reviewStatus: "ACCEPTED" } }); internalId = created.id; internalType = "MedicationStatement";
        } else if (item.resourceType === "Observation") {
          const quantity = resource.valueQuantity as { value?: unknown; unit?: unknown } | undefined;
          const observedAt = date(resource.effectiveDateTime) ?? date(resource.issued);
          if (observedAt) { const created = await tx.observation.create({ data: { patientId: user.patient!.id, name: codingDisplay(resource.code), valueNumeric: typeof quantity?.value === "number" ? quantity.value : undefined, valueText: text(resource.valueString), unit: text(quantity?.unit), observedAt, reviewStatus: "ACCEPTED" } }); internalId = created.id; }
        } else if (item.resourceType === "Encounter") {
          const period = resource.period as { start?: unknown; end?: unknown } | undefined;
          const startedAt = date(period?.start);
          if (startedAt) { const created = await tx.encounter.create({ data: { patientId: user.patient!.id, encounterType: codingDisplay((resource.type as unknown[])?.[0]), startedAt, endedAt: date(period?.end), reviewStatus: "ACCEPTED" } }); internalId = created.id; }
        } else if (item.resourceType === "Procedure") {
          const created = await tx.procedure.create({ data: { patientId: user.patient!.id, name: codingDisplay(resource.code), performedAt: date(resource.performedDateTime), reviewStatus: "ACCEPTED" } }); internalId = created.id;
        } else if (item.resourceType === "Immunization") {
          const created = await tx.immunization.create({ data: { patientId: user.patient!.id, vaccineName: codingDisplay(resource.vaccineCode), administeredAt: date(resource.occurrenceDateTime), reviewStatus: "ACCEPTED" } }); internalId = created.id;
        }
        await tx.fhirResourceMap.create({ data: { patientId: user.patient!.id, internalType, internalId, fhirResourceType: String(item.resourceType), fhirId: text(item.id), versionId: text((resource.meta as { versionId?: unknown })?.versionId), originalPayload: JSON.parse(JSON.stringify(resource)) } });
      }
    });
    return { status: "IMPORTED", resourceCount: resources.length, originalPayloadsRetained: true };
  }

  @Get(":patientId/fhir/export")
  @RequiresAuthorization()
  @ApiOperation({ summary: "Export authorized FHIR R4 resources as a collection bundle" })
  async export(@Req() req: AuthedRequest, @Param("patientId") raw: string) {
    const patientId = raw === "me" ? (await this.identities.current(req)).patient?.id : uuid.parse(raw);
    if (!patientId) throw new BadRequestException("A patient profile is required.");
    await this.authorization.assert(req, patientId, "read", "fhir", undefined, "fhir-export");
    const maps = await this.database.client().fhirResourceMap.findMany({ where: { patientId }, orderBy: { createdAt: "asc" } });
    return { resourceType: "Bundle", type: "collection", id: randomUUID(), entry: maps.map((map) => ({ fullUrl: map.fhirId ? `urn:uuid:${map.fhirId}` : undefined, resource: map.originalPayload })) };
  }
}
