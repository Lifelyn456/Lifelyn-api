import { ForbiddenException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { OrganizationsController } from "../src/modules/organizations/organizations.controller.js";
import { IdentityService } from "../src/common/identity.service.js";
import { DatabaseService } from "../src/common/database.service.js";
import type { AuthedRequest } from "../src/common/auth-context.js";

type Row = Record<string, unknown>;

class FakeDatabaseService {
  users: Row[] = [];
  providers: Row[] = [];
  organizations: Row[] = [];
  memberships: Row[] = [];

  client() {
    return {
      user: {
        findUnique: async ({ where }: { where: { authSubject: string } }) =>
          this.users.find((u) => u.authSubject === where.authSubject) ?? null,
      },
      providerProfile: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          this.providers.find((p) => p.id === where.id) ?? null,
      },
      organization: {
        create: async ({ data }: { data: Row }) => {
          const row = { id: randomUUID(), verificationStatus: "PENDING", createdAt: new Date(), updatedAt: new Date(), ...data };
          this.organizations.push(row);
          return row;
        },
        findUnique: async ({ where }: { where: { id: string } }) =>
          this.organizations.find((o) => o.id === where.id) ?? null,
      },
      organizationMembership: {
        create: async ({ data }: { data: Row }) => {
          const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data };
          this.memberships.push(row);
          return row;
        },
        findUnique: async ({ where }: { where: { organizationId_providerId: { organizationId: string; providerId: string } } }) =>
          this.memberships.find(
            (m) =>
              m.organizationId === where.organizationId_providerId.organizationId &&
              m.providerId === where.organizationId_providerId.providerId,
          ) ?? null,
        findMany: async ({ where }: { where: { organizationId: string } }) =>
          this.memberships.filter((m) => m.organizationId === where.organizationId),
        upsert: async ({ where, create, update }: { where: { organizationId_providerId: { organizationId: string; providerId: string } }; create: Row; update: Row }) => {
          const existing = this.memberships.find(
            (m) =>
              m.organizationId === where.organizationId_providerId.organizationId &&
              m.providerId === where.organizationId_providerId.providerId,
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...create };
          this.memberships.push(row);
          return row;
        },
        updateMany: async ({ where, data }: { where: { organizationId: string; providerId: string }; data: Row }) => {
          const rows = this.memberships.filter((m) => m.organizationId === where.organizationId && m.providerId === where.providerId);
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      },
      $transaction: async (fn: (tx: ReturnType<FakeDatabaseService["client"]>) => unknown) => fn(this.client()),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  async onModuleDestroy() {}
}

function actor(wallet: string): AuthedRequest {
  return { headers: {}, id: "req-1", actor: { wallet, subject: wallet, capability: "wallet_identity", mfa: false } };
}

describe("OrganizationsController", () => {
  let db: FakeDatabaseService;
  let identities: IdentityService;
  let controller: OrganizationsController;

  const founderWallet = "wallet-founder";
  const outsiderWallet = "wallet-outsider";
  const memberWallet = "wallet-member";

  const founderProviderId = randomUUID();
  const outsiderProviderId = randomUUID();
  const memberProviderId = randomUUID();

  beforeEach(() => {
    db = new FakeDatabaseService();
    db.providers = [
      { id: founderProviderId, verificationStatus: "VERIFIED" },
      { id: outsiderProviderId, verificationStatus: "VERIFIED" },
      { id: memberProviderId, verificationStatus: "VERIFIED" },
    ];
    db.users = [
      { authSubject: founderWallet, status: "ACTIVE", provider: { id: founderProviderId } },
      { authSubject: outsiderWallet, status: "ACTIVE", provider: { id: outsiderProviderId } },
      { authSubject: memberWallet, status: "ACTIVE", provider: { id: memberProviderId } },
    ];
    identities = new IdentityService(db as unknown as DatabaseService);
    controller = new OrganizationsController(db as unknown as DatabaseService, identities);
  });

  it("makes the founding provider an ADMIN member on creation", async () => {
    const org = await controller.create(actor(founderWallet), { name: "Riverside Clinic", type: "CLINIC" });
    expect(db.memberships).toHaveLength(1);
    expect(db.memberships[0]).toMatchObject({ organizationId: org.id, providerId: founderProviderId, role: "ADMIN", status: "ACTIVE" });
  });

  it("lets a member read the organization but blocks a non-member", async () => {
    const org = await controller.create(actor(founderWallet), { name: "Riverside Clinic", type: "CLINIC" });
    await expect(controller.detail(actor(founderWallet), org.id)).resolves.toMatchObject({ id: org.id });
    await expect(controller.detail(actor(outsiderWallet), org.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets an ADMIN add a member, and blocks a non-admin member from adding one", async () => {
    const org = await controller.create(actor(founderWallet), { name: "Riverside Clinic", type: "CLINIC" });
    await controller.addMember(actor(founderWallet), org.id, { providerId: memberProviderId, role: "MEMBER" });
    expect(db.memberships).toHaveLength(2);

    await expect(
      controller.addMember(actor(memberWallet), org.id, { providerId: outsiderProviderId, role: "MEMBER" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("lets an ADMIN promote a member, and blocks a non-admin from doing so", async () => {
    const org = await controller.create(actor(founderWallet), { name: "Riverside Clinic", type: "CLINIC" });
    await controller.addMember(actor(founderWallet), org.id, { providerId: memberProviderId, role: "MEMBER" });

    await expect(
      controller.updateMember(actor(memberWallet), org.id, memberProviderId, { role: "ADMIN" }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await controller.updateMember(actor(founderWallet), org.id, memberProviderId, { role: "ADMIN" });
    const membership = db.memberships.find((m) => m.providerId === memberProviderId);
    expect(membership?.role).toBe("ADMIN");
  });
});
