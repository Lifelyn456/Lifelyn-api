import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateIngestResult } from "../src/common/ai-schemas.js";

const versionId = "11111111-1111-4111-8111-111111111111";
const text = "2026-01-02\nAllergy: penicillin";
const base = {
  schemaVersion: "1.0", recordVersionId: versionId,
  events: [{ event_type: "clinical_note", occurred_at: "2026-01-02T00:00:00Z", certainty: "confirmed", source_kind: "import", self_reported: false, display: "Allergy: penicillin", source_span_ids: ["page-1"] }],
  entities: [{ entity_type: "Allergy", name: "penicillin", value_text: null, value_numeric: null, unit: null, occurred_at: "2026-01-02T00:00:00Z", status: "unknown", source_span_ids: ["page-1"] }],
  citations: [{ spanId: "page-1", recordVersionId: versionId, page: 1, start: 0, end: text.length, text, textHash: createHash("sha256").update(text).digest("hex") }],
  warnings: [], modelTrace: { provider: "deterministic-extractive", model: "native-text-first", promptVersion: "history-v1" },
};

describe("AI ingest trust boundary", () => {
  it("accepts cited results for the requested version and source trust", () => {
    expect(validateIngestResult(base, versionId, "import", "history-v1").spanMap.size).toBe(1);
  });
  it("rejects source upgrades and tampered evidence", () => {
    expect(() => validateIngestResult({ ...base, events: [{ ...base.events[0], source_kind: "provider" }] }, versionId, "import", "history-v1")).toThrow("INVALID_AI_EVENT");
    expect(() => validateIngestResult({ ...base, citations: [{ ...base.citations[0], textHash: "0".repeat(64) }] }, versionId, "import", "history-v1")).toThrow("INVALID_AI_CITATION");
  });
});
