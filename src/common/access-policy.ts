export type Actor = {
  userId: string;
  patientId?: string;
  providerId?: string;
  role:
    | "PATIENT"
    | "CLINICIAN"
    | "ORG_ADMIN"
    | "SUPPORT_ADMIN"
    | "SYSTEM_WORKER";
  verified: boolean;
  mfa: boolean;
};
export type Grant = {
  patientId: string;
  recipientId: string;
  startsAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  status: string;
  scope: { actions: string[]; resourceClasses: string[]; recordIds?: string[] };
};
export function authorize(
  actor: Actor,
  patientId: string,
  action: string,
  resourceClass: string,
  grants: Grant[],
  now: Date,
  recordId?: string,
): { allowed: boolean; code: string; grant?: Grant } {
  if (actor.role === "PATIENT" && actor.patientId === patientId)
    return { allowed: true, code: "OWNER" };
  if (
    actor.role !== "CLINICIAN" ||
    !actor.providerId ||
    !actor.verified ||
    !actor.mfa
  )
    return { allowed: false, code: "VERIFIED_PROVIDER_REQUIRED" };
  const grant = grants.find(
    (g) =>
      g.patientId === patientId &&
      g.recipientId === actor.providerId &&
      g.status === "ACTIVE" &&
      !g.revokedAt &&
      g.startsAt <= now &&
      g.expiresAt > now &&
      g.scope.actions.includes(action) &&
      g.scope.resourceClasses.includes(resourceClass) &&
      (!g.scope.recordIds ||
        (recordId !== undefined && g.scope.recordIds.includes(recordId))),
  );
  return grant
    ? { allowed: true, code: "CONSENT_GRANTED", grant }
    : { allowed: false, code: "CONSENT_REQUIRED" };
}
