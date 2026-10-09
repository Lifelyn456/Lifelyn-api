import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { SignerError } from "./contracts.js";
import type { SignerService } from "./service.js";

const submitSchema = z
  .object({
    network: z.string().min(1).max(32),
    // Accepted for compatibility with the API's request shape, then ignored: the signer only
    // ever talks to the RPC endpoint in its own configuration.
    rpcUrl: z.string().max(2048).optional(),
    contractId: z.string().min(1).max(64),
    method: z.string().min(1).max(64),
    args: z.record(z.string().max(64), z.union([z.string().max(256), z.number(), z.boolean()])),
  })
  .strict();

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_.\-]{8,200}$/;

function sameToken(presented: string | undefined, expected: string) {
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(presented ?? "").digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function buildSignerServer(service: SignerService, authToken: string, options: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    bodyLimit: 16 * 1024,
    logger: options.logger === false ? false : { redact: ["req.headers.authorization"] },
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SignerError) return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError) return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "The request body is not valid." } });
    // Client errors raised by Fastify itself (oversized body, rate limit, wrong content type).
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413) return reply.status(413).send({ error: { code: "TOO_LARGE", message: "The request body is too large." } });
    if (status === 429) return reply.status(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests." } });
    if (status && status >= 400 && status < 500) return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "The request is not valid." } });
    // Anything else is unexpected: log it, but never echo details (they could contain addresses or hashes).
    app.log.error({ err: error }, "unexpected signer error");
    return reply.status(500).send({ error: { code: "INTERNAL", message: "The signer failed unexpectedly." } });
  });

  // Liveness only: no authentication and no information about keys, contracts or the network.
  app.get("/healthz", async () => ({ status: "ok" }));

  app.addHook("onRequest", async (request) => {
    if (request.url === "/healthz") return;
    const header = request.headers.authorization;
    const presented = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!sameToken(presented, authToken)) throw new SignerError(401, "UNAUTHORIZED", "A valid bearer token is required.");
  });

  app.post("/", async (request) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) throw new SignerError(400, "INVALID_IDEMPOTENCY_KEY", "An Idempotency-Key header of 8 to 200 safe characters is required.");
    const { network, contractId, method, args } = submitSchema.parse(request.body);
    return service.submit({ network, contractId, method, args }, key);
  });

  app.get<{ Params: { txHash: string } }>("/v1/transactions/:txHash", async (request) => ({ status: await service.status(request.params.txHash) }));

  return app;
}
