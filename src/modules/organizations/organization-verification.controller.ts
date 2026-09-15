import { Body, Controller, Headers, Param, Patch, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Public } from "../../common/authorization.decorators.js";
import { DatabaseService } from "../../common/database.service.js";

const bodySchema = z.object({ status: z.enum(["VERIFIED", "REJECTED"]) }).strict();

@Controller("internal/v1/organizations")
export class OrganizationVerificationController {
  constructor(private readonly database: DatabaseService) {}

  @Patch(":organizationId/verification")
  @Public()
  async update(@Headers("authorization") auth: string, @Param("organizationId") organizationId: string, @Body() raw: unknown) {
    const expected = process.env.ORG_VERIFIER_TOKEN;
    const received = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!expected || expected.length < 32) throw new ServiceUnavailableException("Organization verifier is not configured.");
    const a = Buffer.from(expected);
    const b = Buffer.from(received);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException("Verifier authentication failed.");
    const body = bodySchema.parse(raw);
    const organization = await this.database.client().organization.update({
      where: { id: z.string().uuid().parse(organizationId) },
      data: { verificationStatus: body.status },
    });
    return { id: organization.id, verificationStatus: organization.verificationStatus };
  }
}
