import { describe, expect, it } from "vitest";
import { validate_bundle } from "../src/modules/fhir/fhir.mapper.js";

describe("FHIR boundary validation", () => {
  it("preserves supported originals and their version metadata", () => {
    const input = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Observation", id: "o1", meta: { versionId: "3" }, valueString: "negative" } }] };
    const result = validate_bundle(input);
    expect(result).toHaveLength(1);
    expect(result[0].originalPayload).toBe(input.entry[0].resource);
  });

  it("does not silently drop malformed or unsupported bundle entries", () => {
    expect(() => validate_bundle({ resourceType: "Bundle", entry: [{ resource: { resourceType: "Claim" } }] })).toThrow("UNSUPPORTED_FHIR_RESOURCE");
    expect(() => validate_bundle({ resourceType: "Bundle", entry: [{}] })).toThrow("INVALID_FHIR_PAYLOAD");
  });
});
