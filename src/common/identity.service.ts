import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { AuthedRequest } from "./auth-context.js";
import { DatabaseService } from "./database.service.js";

export const profileSchema = z.object({
  role: z.enum(["PATIENT", "CLINICIAN"]),
  displayName: z.string().trim().min(1).max(100),
  email: z.string().email().max(254).optional(),
  providerType: z.string().trim().min(1).max(80).optional(),
}).strict();

@Injectable()
export class IdentityService {
  constructor(private readonly database: DatabaseService) {}

  async current(req: AuthedRequest) {
    const user = await this.database.client().user.findUnique({
      where: { authSubject: req.actor!.wallet },
      include: { patient: true, provider: true },
    });
    if (!user || user.status !== "ACTIVE") throw new NotFoundException("Complete account registration first.");
    return user;
  }

  async register(req: AuthedRequest, input: z.infer<typeof profileSchema>) {
    if (input.role === "CLINICIAN" && !input.providerType) {
      throw new ForbiddenException("Provider type is required for clinician registration.");
    }
    const db = this.database.client();
    const existing = await db.user.findUnique({ where: { authSubject: req.actor!.wallet } });
    if (existing && existing.role !== input.role) {
      throw new ForbiddenException("Account role cannot be changed after registration.");
    }
    return db.user.upsert({
      where: { authSubject: req.actor!.wallet },
      create: {
        authSubject: req.actor!.wallet,
        email: input.email,
        role: input.role,
        mfaState: input.role === "CLINICIAN" ? "PENDING" : "NOT_REQUIRED",
        ...(input.role === "PATIENT"
          ? { patient: { create: { displayName: input.displayName, stellarSubjectRef: randomBytes(32).toString("hex") } } }
          : { provider: { create: { displayName: input.displayName, providerType: input.providerType! } } }),
      },
      update: {
        email: input.email,
        ...(input.role === "PATIENT"
          ? { patient: { update: { displayName: input.displayName } } }
          : { provider: { update: { displayName: input.displayName, providerType: input.providerType! } } }),
      },
      include: { patient: true, provider: true },
    });
  }
}
