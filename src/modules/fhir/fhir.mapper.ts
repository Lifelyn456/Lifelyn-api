const SUPPORTED = new Set([
  "Patient", "Practitioner", "Organization", "Encounter", "Condition",
  "AllergyIntolerance", "MedicationRequest", "MedicationStatement", "Observation",
  "Procedure", "Immunization", "DocumentReference",
]);

type FhirResource = Record<string, unknown> & { resourceType: string };

function resource(value: unknown): FhirResource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_FHIR_PAYLOAD");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.resourceType !== "string" || !SUPPORTED.has(candidate.resourceType)) throw new Error("UNSUPPORTED_FHIR_RESOURCE");
  return candidate as FhirResource;
}

export function validate_bundle(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_FHIR_PAYLOAD");
  const value = body as Record<string, unknown>;
  let resources: FhirResource[];
  if (value.resourceType === "Bundle") {
    if (!Array.isArray(value.entry) || value.entry.length > 1_000) throw new Error("INVALID_FHIR_BUNDLE");
    resources = value.entry.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("INVALID_FHIR_BUNDLE_ENTRY");
      return resource((entry as Record<string, unknown>).resource);
    });
  } else {
    resources = [resource(value)];
  }
  return resources.map((item) => ({ resourceType: item.resourceType, id: item.id, originalPayload: item }));
}
