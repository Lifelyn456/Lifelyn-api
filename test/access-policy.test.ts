import { describe, it, expect } from "vitest";
import {
  authorize,
  type Actor,
  type Grant,
} from "../src/common/access-policy.js";
const now = new Date("2026-09-12T12:00:00Z");
const actor: Actor = {
  userId: "u1",
  providerId: "c1",
  role: "CLINICIAN",
  verified: true,
  mfa: true,
};
const grant: Grant = {
  patientId: "p1",
  recipientId: "c1",
  startsAt: new Date("2026-09-11"),
  expiresAt: new Date("2026-09-13"),
  revokedAt: null,
  status: "ACTIVE",
  scope: { actions: ["read"], resourceClasses: ["lab"] },
};
describe("patient consent authorization", () => {
  it("allows scoped active verified providers", () =>
    expect(authorize(actor, "p1", "read", "lab", [grant], now).allowed).toBe(
      true,
    ));
  it.each([
    { ...grant, revokedAt: now },
    { ...grant, expiresAt: now },
    { ...grant, startsAt: new Date("2026-09-13") },
    { ...grant, patientId: "p2" },
    { ...grant, recipientId: "c2" },
    { ...grant, status: "PENDING" },
  ])("denies revoked, expired, premature, or unrelated grants", (g) =>
    expect(authorize(actor, "p1", "read", "lab", [g], now).allowed).toBe(false),
  );
  it("rejects cross-scope access", () =>
    expect(
      authorize(actor, "p1", "read", "medication", [grant], now).allowed,
    ).toBe(false));
  it("rejects support bypass", () =>
    expect(
      authorize(
        { ...actor, role: "SUPPORT_ADMIN" },
        "p1",
        "read",
        "lab",
        [grant],
        now,
      ).allowed,
    ).toBe(false));
  it("requires MFA and verification", () => {
    expect(
      authorize({ ...actor, mfa: false }, "p1", "read", "lab", [grant], now)
        .allowed,
    ).toBe(false);
    expect(
      authorize(
        { ...actor, verified: false },
        "p1",
        "read",
        "lab",
        [grant],
        now,
      ).allowed,
    ).toBe(false);
  });
  it("record-level scope cannot authorize an unfiltered list", () =>
    expect(
      authorize(
        actor,
        "p1",
        "read",
        "lab",
        [{ ...grant, scope: { ...grant.scope, recordIds: ["r1"] } }],
        now,
      ).allowed,
    ).toBe(false));
});
