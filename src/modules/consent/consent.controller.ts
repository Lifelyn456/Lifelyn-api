import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { WalletJwtGuard, type AuthedRequest } from "../../common/auth-context.js";
import { AuthorizationService } from "../../common/authorization.service.js";
import { DatabaseService } from "../../common/database.service.js";
import { IdentityService } from "../../common/identity.service.js";
import { JobsService } from "../jobs/jobs.service.js";
import { RequiresAuthorization, SkipAuthorization } from "../../common/authorization.decorators.js";

const uuid = z.string().uuid();
const scopeSchema = z.object({ actions: z.array(z.enum(["read", "ask", "attest", "integrity-check"])).min(1).max(10), resourceClasses: z.array(z.string().min(1).max(80)).min(1).max(30), recordIds: z.array(z.string().uuid()).max(500).optional() }).strict();
const requestSchema = z.object({ scope: scopeSchema, expiresAt: z.string().datetime(), purpose: z.string().trim().min(1).max(300) }).strict();
const approveSchema = z.object({ scope: scopeSchema, startsAt: z.string().datetime().optional(), expiresAt: z.string().datetime() }).strict();

function canonicalScope(scope: z.infer<typeof scopeSchema>) {
  return { actions: [...new Set(scope.actions)].sort(), resourceClasses: [...new Set(scope.resourceClasses)].sort(), ...(scope.recordIds ? { recordIds: [...new Set(scope.recordIds)].sort() } : {}) };
}
function includesAll(requested: z.infer<typeof scopeSchema>, approved: z.infer<typeof scopeSchema>) {
  return approved.actions.every((x) => requested.actions.includes(x)) && approved.resourceClasses.every((x) => requested.resourceClasses.includes(x)) && (!approved.recordIds || (!!requested.recordIds && approved.recordIds.every((x) => requested.recordIds!.includes(x))));
}

@Controller("v1/patients")
@ApiBearerAuth()
@UseGuards(WalletJwtGuard)
export class ConsentController {
  constructor(private readonly database: DatabaseService, private readonly identities: IdentityService, private readonly jobs: JobsService, private readonly authorization: AuthorizationService) {}

  @Post(":patientId/access-requests")
  @SkipAuthorization("This creates a REQUEST for future access, not a read of the patient's consent-gated resources; it checks verified-provider status and MFA inline and records its own AccessEvent, since no active ConsentGrant can exist yet for a request that hasn't been approved.")
  @ApiOperation({ summary: "Request explicit patient access as a verified clinician with MFA" })
  async request(@Req() req: AuthedRequest, @Param("patientId") patientIdRaw: string, @Body() body: unknown) {
    const patientId = uuid.parse(patientIdRaw);
    const input = requestSchema.parse(body);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt <= new Date()) throw new BadRequestException("Request expiry must be in the future.");
    const user = await this.identities.current(req);
    if (!user.provider || user.provider.verificationStatus !== "VERIFIED" || user.mfaState !== "ENROLLED" || !req.actor?.mfa) throw new BadRequestException("Verified provider status and a current MFA assertion are required.");
    const patient = await this.database.client().patientProfile.findUnique({ where: { id: patientId } });
    if (!patient) throw new NotFoundException("Patient was not found.");
    return this.database.client().$transaction(async (tx) => {
      const request = await tx.consentRequest.create({ data: { patientId, requesterProviderId: user.provider!.id, requestedScopeJson: { scope: canonicalScope(input.scope), purpose: input.purpose }, expiresAt } });
      await tx.accessEvent.create({ data: { patientId, actorUserId: user.id, action: "request-access", resourceType: "consent", resourceId: request.id, purpose: input.purpose, requestId: req.id ?? randomUUID() } });
      return request;
    });
  }

  @Get("me/access-requests")
  @RequiresAuthorization()
  async listRequests(@Req() req: AuthedRequest) {
    const patientId = await this.owner(req);
    await this.authorization.assert(req, patientId, "manage", "consent", undefined, "access-request-list");
    return this.database.client().consentRequest.findMany({ where: { patientId }, include: { requester: { select: { id: true, displayName: true, providerType: true, verificationStatus: true } } }, orderBy: { createdAt: "desc" } });
  }

  @Post("me/access-requests/:id/approve")
  @RequiresAuthorization()
  async approve(@Req() req: AuthedRequest, @Param("id") rawId: string, @Body() body: unknown) {
    const patientId = await this.owner(req);
    await this.authorization.assert(req, patientId, "manage", "consent", undefined, "access-request-approval");
    const requestId = uuid.parse(rawId);
    const input = approveSchema.parse(body);
    const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt <= startsAt) throw new BadRequestException("Consent expiry must be after its start.");
    const row = await this.database.client().consentRequest.findFirst({ where: { id: requestId, patientId, status: "PENDING", expiresAt: { gt: new Date() } } });
    if (!row) throw new NotFoundException("Pending access request was not found.");
    const requested = scopeSchema.parse((row.requestedScopeJson as { scope?: unknown }).scope);
    const scope = canonicalScope(input.scope);
    if (!includesAll(requested, scope)) throw new BadRequestException("Approved scope cannot exceed the requested scope.");
    const scopeManifestHash = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
    const stellarRef = randomBytes(32).toString("hex");
    const grant = await this.database.client().$transaction(async (tx) => {
      await tx.consentRequest.update({ where: { id: row.id }, data: { status: "APPROVED" } });
      return tx.consentGrant.create({ data: { patientId, recipientType: "PROVIDER", recipientId: row.requesterProviderId, scope, scopeManifestHash, startsAt, expiresAt, stellarRef, status: "PENDING_CHAIN" } });
    });
    await this.jobs.add("stellar-submit", { operation: "grant", grantId: grant.id, correlationId: req.id }, `stellar-grant:${grant.id}`);
    return grant;
  }

  @Post("me/access-requests/:id/reject")
  @RequiresAuthorization()
  async reject(@Req() req: AuthedRequest, @Param("id") rawId: string) {
    const patientId = await this.owner(req);
    await this.authorization.assert(req, patientId, "manage", "consent", undefined, "access-request-rejection");
    const result = await this.database.client().consentRequest.updateMany({ where: { id: uuid.parse(rawId), patientId, status: "PENDING" }, data: { status: "REJECTED" } });
    if (!result.count) throw new NotFoundException("Pending access request was not found.");
    return { status: "REJECTED" };
  }

  @Get("me/consents")
  @RequiresAuthorization()
  async list(@Req() req: AuthedRequest) {
    const patientId = await this.owner(req);
    await this.authorization.assert(req, patientId, "manage", "consent", undefined, "consent-list");
    return this.database.client().consentGrant.findMany({ where: { patientId }, orderBy: { createdAt: "desc" } });
  }

  @Post("me/consents/:id/revoke")
  @RequiresAuthorization()
  async revoke(@Req() req: AuthedRequest, @Param("id") rawId: string) {
    const patientId = await this.owner(req);
    await this.authorization.assert(req, patientId, "manage", "consent", undefined, "consent-revocation");
    const id = uuid.parse(rawId);
    const result = await this.database.client().consentGrant.updateMany({ where: { id, patientId, revokedAt: null }, data: { revokedAt: new Date(), status: "REVOKED" } });
    if (!result.count) throw new NotFoundException("Active consent was not found.");
    await this.jobs.add("stellar-submit", { operation: "revoke", grantId: id, correlationId: req.id }, `stellar-revoke:${id}`);
    return { id, status: "REVOKED", futureAccessBlocked: true };
  }

  private async owner(req: AuthedRequest) {
    const user = await this.identities.current(req);
    if (!user.patient) throw new BadRequestException("A patient profile is required.");
    return user.patient.id;
  }
}
