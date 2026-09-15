import { createHash } from "node:crypto";
import { z } from "zod";

export type SourceKind = "provider" | "patient" | "import";

const span = z.object({
  spanId: z.string().min(1).max(100), recordVersionId: z.string().uuid(), page: z.number().int().positive(),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1).max(20_000),
  textHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const ingestResponseSchema = z.object({
  schemaVersion: z.literal("1.0"),
  recordVersionId: z.string().uuid(),
  events: z.array(z.object({
    event_type: z.string().trim().min(1).max(100), occurred_at: z.string().datetime(),
    certainty: z.enum(["confirmed", "probable", "possible", "unknown"]), source_kind: z.enum(["provider", "patient", "import"]),
    self_reported: z.boolean(), display: z.string().trim().min(1).max(500),
    source_span_ids: z.array(z.string().min(1).max(100)).min(1).max(20),
  }).strict()),
  entities: z.array(z.object({
    entity_type: z.enum(["Condition", "MedicationStatement", "Allergy", "Observation", "Encounter", "Procedure", "Immunization"]),
    name: z.string().trim().min(1).max(200), value_text: z.string().max(500).nullable(), value_numeric: z.number().finite().nullable(),
    unit: z.string().max(40).nullable(), occurred_at: z.string().datetime().nullable(), status: z.string().trim().min(1).max(50),
    source_span_ids: z.array(z.string().min(1).max(100)).min(1).max(20),
  }).strict()),
  citations: z.array(span).max(5_000),
  warnings: z.array(z.string().max(500)).max(100),
  modelTrace: z.object({ provider: z.string().min(1).max(100), model: z.string().min(1).max(100), promptVersion: z.string().min(1).max(100) }).strict(),
}).strict();

export function validateIngestResult(raw: unknown, recordVersionId: string, sourceKind: SourceKind, pipelineVersion: string) {
  const result = ingestResponseSchema.parse(raw);
  if (result.recordVersionId !== recordVersionId) throw new Error("AI_RECORD_VERSION_MISMATCH");
  if (result.modelTrace.promptVersion !== pipelineVersion) throw new Error("AI_PIPELINE_VERSION_MISMATCH");
  const spanMap = new Map<string, (typeof result.citations)[number]>();
  for (const citation of result.citations) {
    if (citation.recordVersionId !== recordVersionId || citation.end <= citation.start || citation.end - citation.start !== citation.text.length || createHash("sha256").update(citation.text).digest("hex") !== citation.textHash || spanMap.has(citation.spanId)) throw new Error("INVALID_AI_CITATION");
    spanMap.set(citation.spanId, citation);
  }
  for (const event of result.events) {
    if (event.source_kind !== sourceKind || event.self_reported !== (sourceKind === "patient") || event.source_span_ids.some((spanId) => !spanMap.has(spanId)) || new Set(event.source_span_ids).size !== event.source_span_ids.length) throw new Error("INVALID_AI_EVENT");
  }
  for (const entity of result.entities) {
    if (entity.source_span_ids.some((spanId) => !spanMap.has(spanId)) || new Set(entity.source_span_ids).size !== entity.source_span_ids.length) throw new Error("INVALID_AI_ENTITY");
  }
  return { result, spanMap };
}
