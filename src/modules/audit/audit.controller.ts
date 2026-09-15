import { BadRequestException, Controller, Get, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { WalletJwtGuard, type AuthedRequest } from "../../common/auth-context.js";
import { DatabaseService } from "../../common/database.service.js";
import { IdentityService } from "../../common/identity.service.js";

@Controller("v1/patients/me/audit")
@ApiBearerAuth()
@UseGuards(WalletJwtGuard)
export class AuditController {
  constructor(private readonly database: DatabaseService, private readonly identities: IdentityService) {}
  @Get()
  @ApiOperation({ summary: "Read append-only access history for the authenticated patient" })
  async list(@Req() req: AuthedRequest) {
    const user = await this.identities.current(req);
    if (!user.patient) throw new BadRequestException("A patient profile is required.");
    return this.database.client().accessEvent.findMany({ where: { patientId: user.patient.id }, select: { id: true, action: true, resourceType: true, resourceId: true, purpose: true, requestId: true, occurredAt: true, actor: { select: { id: true, role: true, provider: { select: { displayName: true } } } } }, orderBy: { occurredAt: "desc" }, take: 500 });
  }
}
