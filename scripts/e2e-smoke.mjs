// Cross-service end-to-end smoke test for the local Lifelyn dev stack: wallet login -> register
// patient -> upload a record -> wait for AI ingestion -> accept extracted facts -> ask a cited
// question against lifelyn-ai. Each repo's own test suite mocks the other side of this boundary
// (see lifelyn-ai/src/lifelyn_ai/evals/golden_runner.py's hand-built service-auth headers vs.
// lifelyn-api/src/integrations/ai-client.ts's real ones), so a real cross-service integration
// bug -- e.g. a missing JWT `typ` header -- can pass every unit test in both repos and only
// surfaces here. Run against a fully running local stack (docker compose infra + `pnpm dev` +
// `pnpm dev:worker` in lifelyn-api + `uvicorn` in lifelyn-ai) with:
//   node scripts/e2e-smoke.mjs
// Override the API base with E2E_API_BASE_URL if it's not on the default local dev port.
import { Keypair } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";

const BASE = process.env.E2E_API_BASE_URL ?? "http://127.0.0.1:4010";
const ORIGIN = "http://127.0.0.1:3000";

function sign(key, message) {
  return Buffer.from(
    key.sign(createHash("sha256").update("Stellar Signed Message:\n" + message).digest()),
  ).toString("base64");
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "content-type": "application/json", origin: ORIGIN, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    console.error(`FAILED ${opts.method ?? "GET"} ${path} -> ${res.status}`, JSON.stringify(body));
    throw new Error(`${path} failed with ${res.status}`);
  }
  return body;
}

// Builds a minimal single-page PDF whose content stream is a handful of `Label: value` lines.
// lifelyn-ai's ingestion extractor (src/lifelyn_ai/ingestion/extractor.py) is a deterministic
// "conservative extractive" pipeline: it only turns `^Label: value$` lines into structured facts
// and deliberately never infers facts from free prose, so the fixture text must match that shape
// to exercise a real (non-empty) extraction during this smoke test.
function buildFixturePdf() {
  const lines = [
    "Patient: Smoke Test Patient",
    "Date: 2021-03-15",
    "Allergy: Seasonal pollen allergy",
    "Medication: Loratadine 10mg once daily",
    "Condition: Seasonal allergic rhinitis",
  ];
  const text = lines.map((line) => `(${line.replace(/[()\\]/g, "\\$&")}) Tj T*`).join("\n");
  const stream = `BT /F1 12 Tf 40 700 Td 16 TL\n${text}\nET`;
  const objects = {
    1: "<< /Type /Catalog /Pages 2 0 R >>",
    2: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    3: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>",
    4: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    5: `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  };
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

async function main() {
  const key = Keypair.random();
  console.log("Patient wallet address:", key.publicKey());

  const challenge = await api("/v1/auth/challenge", { method: "POST", body: JSON.stringify({ address: key.publicKey() }) });
  console.log("1. Got challenge:", challenge.id);

  const signature = sign(key, challenge.message);
  const { token } = await api("/v1/auth/verify", { method: "POST", body: JSON.stringify({ id: challenge.id, address: key.publicKey(), signature }) });
  console.log("2. Verified signature, got wallet JWT");

  const auth = { authorization: `Bearer ${token}` };

  const me = await api("/v1/me", { method: "PATCH", headers: auth, body: JSON.stringify({ role: "PATIENT", displayName: "Smoke Test Patient" }) });
  console.log("3. Registered patient:", me.id, me.role);

  const fileBytes = buildFixturePdf();
  const uploadReq = await api("/v1/patients/me/records/upload-url", {
    method: "POST", headers: auth,
    body: JSON.stringify({ filename: "smoke-test.pdf", mimeType: "application/pdf", sizeBytes: fileBytes.length, recordType: "CLINICAL_NOTE", sourceType: "UPLOAD" }),
  });
  console.log("4. Got upload URL for record:", uploadReq.recordId);

  const putRes = await fetch(uploadReq.uploadUrl, { method: "PUT", headers: { "content-type": "application/pdf", ...(uploadReq.headers ?? {}) }, body: fileBytes });
  console.log("5. Uploaded PDF bytes, status:", putRes.status, await putRes.text().catch(() => ""));

  const finalized = await api("/v1/patients/me/records/finalize", { method: "POST", headers: auth, body: JSON.stringify({ recordId: uploadReq.recordId, objectKey: uploadReq.objectKey }) });
  console.log("6. Finalized record:", JSON.stringify(finalized));

  // Terminal states from worker.ts's record-ingest job: READY (no findings needed review),
  // NEEDS_REVIEW (extracted candidate facts await patient accept/reject), or FAILED.
  let status = "QUEUED";
  for (let i = 0; i < 20 && status !== "READY" && status !== "NEEDS_REVIEW" && status !== "FAILED"; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const rec = await api(`/v1/patients/me/records/${uploadReq.recordId}`, { headers: auth });
    status = rec.status;
    console.log(`   ...ingestion status: ${status}`);
  }
  console.log("7. Final ingestion status:", status);
  if (status !== "NEEDS_REVIEW" && status !== "READY") throw new Error(`Ingestion did not complete: ${status}`);

  // Newly extracted MedicalEvents sit in PENDING_REVIEW until the patient accepts/corrects them
  // (PRD invariant: AI-extracted facts are untrusted until a human confirms them), and the ask
  // pipeline only cites ACCEPTED/CORRECTED events -- so the smoke test must accept them here to
  // exercise a real cited answer instead of the "insufficient evidence" fallback.
  const timeline = await api("/v1/patients/me/timeline", { headers: auth });
  console.log(`7b. Timeline has ${timeline.length} event(s) pending review`);
  for (const event of timeline) {
    if (event.reviewStatus !== "PENDING_REVIEW") continue;
    await api(`/v1/patients/me/events/${event.id}`, {
      method: "PATCH", headers: auth,
      body: JSON.stringify({ reason: "smoke-test accepts extracted fact as-is", fields: {}, reviewStatus: "ACCEPTED" }),
    });
    console.log(`   ...accepted event ${event.id} (${event.eventType})`);
  }

  const convo = await api("/v1/patients/me/conversations", { method: "POST", headers: auth, body: JSON.stringify({ purpose: "smoke-test" }) });
  console.log("8. Created conversation:", convo.id);

  // Avoid words from lifelyn_ai/safety.py's UNSUPPORTED_TERMS list (e.g. "prescribed",
  // "treatment") -- those intentionally trigger the safety fallback (PRD: no
  // diagnosis/prescription answers), which is correct behavior, not a retrieval bug, but it
  // means this smoke test must ask a purely historical-recall question to see a real citation.
  const answer = await api(`/v1/patients/me/conversations/${convo.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ question: "What allergy and medication are recorded, and when?" }) });
  console.log("9. AI answer:\n" + JSON.stringify(answer, null, 2));
  if (answer.insufficient_evidence || answer.claims.length === 0) throw new Error("Expected a cited, evidence-backed answer but got insufficient_evidence.");
  console.log("\nSMOKE TEST PASSED: full patient journey (wallet auth -> upload -> AI extraction -> review -> cited AI answer) succeeded end-to-end.");
}

main().catch((e) => { console.error("SMOKE TEST FAILED:", e); process.exit(1); });
