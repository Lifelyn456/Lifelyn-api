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
    const token = await new SignJWT({ capability: "lifelyn-ai:invoke", path, correlationId, nonce })
      .setProtectedHeader({ alg: "HS256" }).setSubject("lifelyn-api").setIssuer("lifelyn-api").setAudience("lifelyn-ai").setIssuedAt().setExpirationTime("60s").sign(secret);
    const signature = createHmac("sha256", rawSecret).update(`${nonce}.${body}`).digest("hex");
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-lifelyn-nonce": nonce, "x-lifelyn-signature": signature, "x-correlation-id": correlationId }, body, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new ServiceUnavailableException("Private AI service rejected the request.");
    return response.json();
  }
}
