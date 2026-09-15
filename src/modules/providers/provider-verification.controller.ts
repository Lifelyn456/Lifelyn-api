import { Body, Controller, Headers, Param, Patch, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DatabaseService } from "../../common/database.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import { Public } from "../../common/authorization.decorators.js";

const bodySchema = z.object({ status: z.enum(["VERIFIED", "REJECTED"]), authorityReference: z.string().min(1).max(200) }).strict();

@Controller("internal/v1/providers")
export class ProviderVerificationController {
  constructor(private readonly database: DatabaseService, private readonly jobs: JobsService) {}
  @Patch(":providerId/verification")
  @Public()
  async update(@Headers("authorization") auth: string, @Param("providerId") providerId: string, @Body() raw: unknown) {
    const expected = process.env.PROVIDER_VERIFIER_TOKEN;
    const received = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!expected || expected.length < 32) throw new ServiceUnavailableException("Provider verifier is not configured.");
    const a = Buffer.from(expected); const b = Buffer.from(received);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException("Verifier authentication failed.");
    const body = bodySchema.parse(raw);
    const provider = await this.database.client().providerProfile.update({ where: { id: z.string().uuid().parse(providerId) }, data: { verificationStatus: body.status, verifiedAt: body.status === "VERIFIED" ? new Date() : null } });
    await this.jobs.add("stellar-submit", { operation: "provider-status", providerId: provider.id, verified: body.status === "VERIFIED" }, `stellar-provider-status:${provider.id}:${body.status}`);
    return { id: provider.id, verificationStatus: provider.verificationStatus, verifiedAt: provider.verifiedAt };
  }
}
