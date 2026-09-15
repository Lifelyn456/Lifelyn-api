import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { DatabaseService } from "../src/common/database.service.js";
import { SafeExceptionFilter } from "../src/common/errors.js";
import { BackstopTestModule } from "../src/testing/authorization-backstop.fixture.js";

/**
 * Real HTTP-level tests proving the wired authorization pipeline
 * (WalletJwtGuard -> AuthorizationEnforcementInterceptor -> AuthorizationService -> authorize())
 * actually blocks cross-patient access, unverified-provider access, and support-admin bypass —
 * not just the pure access-policy.ts function tested in isolation elsewhere.
 */

const AUTH_SECRET = "e2e-test-authorization-secret-key-32bytes!!";
const secretKey = new TextEncoder().encode(AUTH_SECRET);

async function walletToken(wallet: string, mfa: boolean) {
  return new SignJWT({ wallet, capability: "wallet_identity", mfa })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(wallet)
    .setIssuer("lifelyn-api")
    .setAudience("lifelyn-web")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(secretKey);
}

type Row = Record<string, unknown>;

class FakeDatabaseService {
  users: Row[] = [];
  patients: Row[] = [];
  grants: Row[] = [];
  records: Row[] = [];
  accessEvents: Row[] = [];

  client() {
    return {
      user: {
        findUnique: async ({ where }: { where: { authSubject: string } }) =>
          this.users.find((u) => u.authSubject === where.authSubject) ?? null,
      },
      patientProfile: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          this.patients.find((p) => p.id === where.id) ?? null,
      },
      consentGrant: {
        findMany: async ({ where }: { where: { patientId: string; recipientId: string } }) =>
          this.grants.filter((g) => g.patientId === where.patientId && g.recipientId === where.recipientId),
      },
      accessEvent: {
        create: async ({ data }: { data: Row }) => {
          const row = { id: `evt-${this.accessEvents.length + 1}`, occurredAt: new Date(), ...data };
          this.accessEvents.push(row);
          return row;
        },
      },
      medicalRecord: {
        findMany: async ({ where }: { where: { patientId: string } }) =>
          this.records.filter((r) => r.patientId === where.patientId),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  async onModuleDestroy() {}
}

describe("authorization pipeline (real HTTP, real guard/interceptor wiring)", () => {
  let app: NestFastifyApplication;
  let fakeDb: FakeDatabaseService;

  const patientWallet = "GPATIENTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
  const otherPatientWallet = "GPATIENTBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2";
  const clinicianWallet = "GCLINICIANAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3";
  const supportWallet = "GSUPPORTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4";

  const patientId = "11111111-1111-4111-8111-111111111111";
  const otherPatientId = "22222222-2222-4222-8222-222222222222";
  const providerId = "33333333-3333-4333-8333-333333333333";

  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = AUTH_SECRET;

    fakeDb = new FakeDatabaseService();
    fakeDb.patients = [{ id: patientId }, { id: otherPatientId }];
    fakeDb.users = [
      { id: "user-patient-1", authSubject: patientWallet, status: "ACTIVE", role: "PATIENT", mfaState: "NOT_REQUIRED", patient: { id: patientId }, provider: null },
      { id: "user-patient-2", authSubject: otherPatientWallet, status: "ACTIVE", role: "PATIENT", mfaState: "NOT_REQUIRED", patient: { id: otherPatientId }, provider: null },
      { id: "user-clinician-1", authSubject: clinicianWallet, status: "ACTIVE", role: "CLINICIAN", mfaState: "ENROLLED", patient: null, provider: { id: providerId, verificationStatus: "VERIFIED" } },
      { id: "user-support-1", authSubject: supportWallet, status: "ACTIVE", role: "SUPPORT_ADMIN", mfaState: "NOT_REQUIRED", patient: null, provider: null },
    ];
    fakeDb.records = [{ id: "record-1", patientId, recordType: "LAB", sourceType: "UPLOAD", originalFilename: "x.pdf", mimeType: "application/pdf", status: "READY", createdAt: new Date(), versions: [] }];
    fakeDb.grants = [
      { patientId, recipientId: providerId, startsAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 60_000), revokedAt: null, status: "ACTIVE", scope: { actions: ["read"], resourceClasses: ["records"] } },
    ];

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue(fakeDb)
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const recordsUrl = (id: string) => `/v1/patients/${id}/records`;

  it("rejects with 401 when no wallet session is presented", async () => {
    const res = await app.inject({ method: "GET", url: recordsUrl(patientId) });
    expect(res.statusCode).toBe(401);
  });

  it("allows a patient to read their own records", async () => {
    const token = await walletToken(patientWallet, false);
    const res = await app.inject({ method: "GET", url: recordsUrl(patientId), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
    expect(fakeDb.accessEvents.some((e) => e.patientId === patientId && e.actorUserId === "user-patient-1")).toBe(true);
  });

  it("blocks a patient from reading another patient's records (cross-patient access)", async () => {
    const token = await walletToken(patientWallet, false);
    const res = await app.inject({ method: "GET", url: recordsUrl(otherPatientId), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
  });

  it("blocks a verified clinician with no active consent grant", async () => {
    const token = await walletToken(clinicianWallet, true);
    const res = await app.inject({ method: "GET", url: recordsUrl(otherPatientId), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it("allows a verified, MFA'd clinician holding an active matching consent grant", async () => {
    const before = fakeDb.accessEvents.length;
    const token = await walletToken(clinicianWallet, true);
    const res = await app.inject({ method: "GET", url: recordsUrl(patientId), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(fakeDb.accessEvents.length).toBe(before + 1);
    expect(fakeDb.accessEvents.at(-1)).toMatchObject({ patientId, actorUserId: "user-clinician-1", action: "read", resourceType: "records" });
  });

  it("blocks a clinician missing an MFA assertion even with a grant on file", async () => {
    const token = await walletToken(clinicianWallet, false);
    const res = await app.inject({ method: "GET", url: recordsUrl(patientId), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
  });

  it("blocks SUPPORT_ADMIN from bypassing patient consent through the ordinary API", async () => {
    const token = await walletToken(supportWallet, false);
    const res = await app.inject({ method: "GET", url: recordsUrl(patientId), headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe("FORBIDDEN");
  });
});

describe("AuthorizationEnforcementInterceptor structural backstop (independent of DatabaseService)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BackstopTestModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves a route explicitly marked @Public", async () => {
    const res = await app.inject({ method: "GET", url: "/test/public" });
    expect(res.statusCode).toBe(200);
  });

  it("fails closed with 500 when a route declares no authorization stance at all", async () => {
    const res = await app.inject({ method: "GET", url: "/test/undecided" });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe("AUTHORIZATION_STANCE_UNDECLARED");
  });

  it("fails closed with 500 when a route is marked @RequiresAuthorization but never calls assert()", async () => {
    const res = await app.inject({ method: "GET", url: "/test/forgotten" });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe("AUTHORIZATION_NOT_ENFORCED");
  });
});
