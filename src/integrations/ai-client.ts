import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHmac, randomUUID } from "node:crypto";
import { SignJWT } from "jose";

@Injectable()
export class AiClient {
  ingest(payload: unknown, correlationId: string) { return this.post("/internal/v1/ingest", payload, correlationId); }
  query(payload: unknown, correlationId: string) { return this.post("/internal/v1/query", payload, correlationId); }
  reindex(payload: unknown, correlationId: string) { return this.post("/internal/v1/reindex", payload, correlationId); }

  private async post(path: string, payload: unknown, correlationId: string) {
    const base = process.env.AI_BASE_URL;
    const rawSecret = process.env.AI_SERVICE_JWT_SECRET;
    if (!base || !rawSecret || Buffer.byteLength(rawSecret) < 32) throw new ServiceUnavailableException("Private AI service is not configured.");
    const body = JSON.stringify(payload);
    const nonce = randomUUID();
    const secret = new TextEncoder().encode(rawSecret);
    // The AI service's require_service_auth() manually re-derives the HS256 signature (it does
    // not use a JWT library) and additionally requires header.typ === "JWT". jose's SignJWT does
    // not set `typ` unless told to, so omitting it here made every single request from this
    // client fail with 401 "Invalid service authentication" — this only ever surfaced in a real
    // cross-service call; each repo's own tests build the token/header differently and never
    // exercised this exact pair.
    const token = await new SignJWT({ capability: "lifelyn-ai:invoke", path, correlationId, nonce })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject("lifelyn-api").setIssuer("lifelyn-api").setAudience("lifelyn-ai").setIssuedAt().setExpirationTime("60s").sign(secret);
    const signature = createHmac("sha256", rawSecret).update(`${nonce}.${body}`).digest("hex");
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-lifelyn-nonce": nonce, "x-lifelyn-signature": signature, "x-correlation-id": correlationId }, body, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new ServiceUnavailableException("Private AI service rejected the request.");
    return response.json();
  }
}
