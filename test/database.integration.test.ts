import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DatabaseService } from "../src/common/database.service.js";

const enabled = process.env.RUN_INTEGRATION === "1";
const database = new DatabaseService();

beforeAll(async () => {
  if (enabled) await database.client().$queryRaw`SELECT 1`;
});

afterAll(async () => {
  if (enabled) await database.onModuleDestroy();
});

(enabled ? it : it.skip)("persists and immediately revokes a scoped consent with its audit event", async () => {
  const db = database.client();
  const suffix = randomUUID();
  const patientUser = await db.user.create({
    data: {
      authSubject: `integration-patient-${suffix}`,
      role: "PATIENT",
      patient: { create: { displayName: "Integration Patient", stellarSubjectRef: randomBytes(32).toString("hex") } },
    },
    include: { patient: true },
  });
  const providerUser = await db.user.create({
    data: {
      authSubject: `integration-provider-${suffix}`,
      role: "CLINICIAN",
      mfaState: "ENROLLED",
      provider: { create: { displayName: "Integration Clinician", providerType: "Physician", verificationStatus: "VERIFIED" } },
    },
    include: { provider: true },
  });
  const grant = await db.consentGrant.create({
    data: {
      patientId: patientUser.patient!.id,
      recipientType: "PROVIDER",
      recipientId: providerUser.provider!.id,
      scope: { actions: ["read"], resourceClasses: ["records"] },
      scopeManifestHash: randomBytes(32).toString("hex"),
      startsAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
      status: "ACTIVE",
    },
  });
  const access = await db.accessEvent.create({
    data: {
      patientId: patientUser.patient!.id,
      actorUserId: providerUser.id,
      action: "read",
      resourceType: "records",
      requestId: randomUUID(),
    },
  });

  const revokedAt = new Date();
  const revoked = await db.consentGrant.update({ where: { id: grant.id }, data: { revokedAt, status: "REVOKED" } });
  expect(revoked.revokedAt).toEqual(revokedAt);
  expect(await db.accessEvent.findUnique({ where: { id: access.id } })).not.toBeNull();

  await db.accessEvent.delete({ where: { id: access.id } });
  await db.consentGrant.delete({ where: { id: grant.id } });
  await db.patientProfile.delete({ where: { id: patientUser.patient!.id } });
  await db.providerProfile.delete({ where: { id: providerUser.provider!.id } });
  await db.user.deleteMany({ where: { id: { in: [patientUser.id, providerUser.id] } } });
});
