import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { z } from "zod";
import { WalletJwtGuard, type AuthedRequest } from "../../common/auth-context.js";
import { SkipAuthorization } from "../../common/authorization.decorators.js";
import { DatabaseService } from "../../common/database.service.js";
import { IdentityService } from "../../common/identity.service.js";

const uuid = z.string().uuid();
const createSchema = z.object({ name: z.string().trim().min(1).max(200), type: z.string().trim().min(1).max(80) }).strict();
const addMemberSchema = z.object({ providerId: uuid, role: z.enum(["ADMIN", "MEMBER"]).default("MEMBER") }).strict();
const updateMemberSchema = z.object({ role: z.enum(["ADMIN", "MEMBER"]).optional(), status: z.enum(["ACTIVE", "SUSPENDED"]).optional() }).strict();

const SELF_SCOPED = "Organization membership contains no patient-consent-gated data; membership/admin role is enforced inline against the requesting provider, not against a patient's ConsentGrant.";

@Controller("v1/organizations")
@ApiBearerAuth()
@UseGuards(WalletJwtGuard)
export class OrganizationsController {
  constructor(private readonly database: DatabaseService, private readonly identities: IdentityService) {}

  @Post()
  @SkipAuthorization(SELF_SCOPED)
  @ApiOperation({ summary: "Create an organization; the founding provider becomes its first ADMIN member" })
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const user = await this.identities.current(req);
    if (!user.provider) throw new BadRequestException("A verified provider profile is required to create an organization.");
    const input = createSchema.parse(body);
    return this.database.client().$transaction(async (tx) => {
      const organization = await tx.organization.create({ data: { name: input.name, type: input.type } });
      await tx.organizationMembership.create({ data: { organizationId: organization.id, providerId: user.provider!.id, role: "ADMIN", status: "ACTIVE" } });
      return organization;
    });
  }

  @Get(":organizationId")
  @SkipAuthorization(SELF_SCOPED)
  @ApiOperation({ summary: "Read an organization the requesting provider belongs to" })
  async detail(@Req() req: AuthedRequest, @Param("organizationId") rawId: string) {
    const organizationId = uuid.parse(rawId);
    await this.requireMember(req, organizationId);
    const organization = await this.database.client().organization.findUnique({ where: { id: organizationId } });
    if (!organization) throw new NotFoundException("Organization was not found.");
    return organization;
  }

  @Get(":organizationId/members")
  @SkipAuthorization(SELF_SCOPED)
  @ApiOperation({ summary: "List an organization's provider memberships" })
  async members(@Req() req: AuthedRequest, @Param("organizationId") rawId: string) {
    const organizationId = uuid.parse(rawId);
    await this.requireMember(req, organizationId);
    return this.database.client().organizationMembership.findMany({
      where: { organizationId },
      include: { provider: { select: { id: true, displayName: true, providerType: true, verificationStatus: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  @Post(":organizationId/members")
  @SkipAuthorization(SELF_SCOPED)
  @ApiOperation({ summary: "Add a verified provider to the organization; ADMIN membership required" })
  async addMember(@Req() req: AuthedRequest, @Param("organizationId") rawId: string, @Body() body: unknown) {
    const organizationId = uuid.parse(rawId);
    await this.requireAdmin(req, organizationId);
    const input = addMemberSchema.parse(body);
    const provider = await this.database.client().providerProfile.findUnique({ where: { id: input.providerId } });
    if (!provider) throw new NotFoundException("Provider was not found.");
    return this.database.client().organizationMembership.upsert({
      where: { organizationId_providerId: { organizationId, providerId: input.providerId } },
      create: { organizationId, providerId: input.providerId, role: input.role, status: "ACTIVE" },
      update: { role: input.role, status: "ACTIVE" },
    });
  }

  @Patch(":organizationId/members/:providerId")
  @SkipAuthorization(SELF_SCOPED)
  @ApiOperation({ summary: "Change a member's role or status; ADMIN membership required" })
  async updateMember(@Req() req: AuthedRequest, @Param("organizationId") rawOrgId: string, @Param("providerId") rawProviderId: string, @Body() body: unknown) {
    const organizationId = uuid.parse(rawOrgId);
    const providerId = uuid.parse(rawProviderId);
    await this.requireAdmin(req, organizationId);
    const input = updateMemberSchema.parse(body);
    const result = await this.database.client().organizationMembership.updateMany({ where: { organizationId, providerId }, data: input });
    if (!result.count) throw new NotFoundException("Membership was not found.");
    return { organizationId, providerId, ...input };
  }

  private async requireMember(req: AuthedRequest, organizationId: string) {
    const user = await this.identities.current(req);
    if (!user.provider) throw new ForbiddenException("A provider profile is required.");
    const membership = await this.database.client().organizationMembership.findUnique({ where: { organizationId_providerId: { organizationId, providerId: user.provider.id } } });
    if (!membership || membership.status !== "ACTIVE") throw new ForbiddenException("Active organization membership is required.");
    return { user, membership };
  }

  private async requireAdmin(req: AuthedRequest, organizationId: string) {
    const { membership } = await this.requireMember(req, organizationId);
    if (membership.role !== "ADMIN") throw new ForbiddenException("Organization ADMIN membership is required.");
    return membership;
  }
}
