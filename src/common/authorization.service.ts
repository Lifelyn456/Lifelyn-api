import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { AuthedRequest } from "./auth-context.js";
import { authorize, type Actor, type Grant } from "./access-policy.js";
import { DatabaseService } from "./database.service.js";
import { IdentityService } from "./identity.service.js";

@Injectable()
export class AuthorizationService {
  constructor(private readonly database: DatabaseService, private readonly identities: IdentityService) {}

  async assert(req: AuthedRequest, patientId: string, action: string, resourceClass: string, resourceId?: string, purpose?: string) {
    const user = await this.identities.current(req);
    const patient = await this.database.client().patientProfile.findUnique({ where: { id: patientId } });
    if (!patient) throw new NotFoundException("Patient was not found.");
    const rows = user.provider
      ? await this.database.client().consentGrant.findMany({ where: { patientId, recipientId: user.provider.id } })
      : [];
    const actor: Actor = {
      userId: user.id,
      patientId: user.patient?.id,
      providerId: user.provider?.id,
      role: user.role as Actor["role"],
      verified: user.provider?.verificationStatus === "VERIFIED",
      mfa: (user.mfaState === "ENROLLED" && req.actor?.mfa === true) || user.role === "PATIENT",
    };
    const grants: Grant[] = rows.map((row) => ({
      patientId: row.patientId,
      recipientId: row.recipientId,
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      status: row.status,
      scope: row.scope as Grant["scope"],
    }));
    const decision = authorize(actor, patientId, action, resourceClass, grants, new Date(), resourceId);
    if (!decision.allowed) throw new ForbiddenException(decision.code === "CONSENT_REQUIRED" ? "Active consent with the required scope is required." : "Verified clinician status and MFA are required.");
    await this.database.client().accessEvent.create({ data: {
      patientId,
      actorUserId: user.id,
      action,
      resourceType: resourceClass,
      resourceId,
      purpose,
      requestId: req.id ?? crypto.randomUUID(),
    } });
    return { user, patient, decision, grants: decision.grant ? [decision.grant] : [] };
  }
}
