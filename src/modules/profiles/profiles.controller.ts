import { Body, Controller, Get, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { WalletJwtGuard, type AuthedRequest } from "../../common/auth-context.js";
import { IdentityService, profileSchema } from "../../common/identity.service.js";
import { DatabaseService } from "../../common/database.service.js";

const patientPatch = z.object({ displayName: z.string().trim().min(1).max(100), emergencyModeEnabled: z.boolean().optional() }).strict();
const providerPatch = z.object({ displayName: z.string().trim().min(1).max(100), providerType: z.string().trim().min(1).max(80) }).strict();
const verificationSchema = z.object({ authority: z.string().trim().min(2).max(160), credentialReference: z.string().trim().min(2).max(200) }).strict();

@Controller("v1")
@ApiBearerAuth()
@UseGuards(WalletJwtGuard)
export class ProfilesController {
  constructor(private readonly identities: IdentityService, private readonly database: DatabaseService) {}

  @Get("me")
  @ApiOperation({ summary: "Read the canonical account resolved from the authenticated Freighter wallet" })
  async me(@Req() req: AuthedRequest) {
    const user = await this.identities.current(req);
    return this.publicUser(user);
  }

  @Patch("me")
  @ApiOperation({ summary: "Register or update an account; Freighter remains the sole login identity" })
  async updateMe(@Req() req: AuthedRequest, @Body() body: unknown) {
    return this.publicUser(await this.identities.register(req, profileSchema.parse(body)));
  }

  @Get("patients/me")
  async patient(@Req() req: AuthedRequest) {
    const user = await this.identities.current(req);
    if (!user.patient) throw new Error("PATIENT_PROFILE_REQUIRED");
    return user.patient;
  }

  @Patch("patients/me")
  async updatePatient(@Req() req: AuthedRequest, @Body() body: unknown) {
    const user = await this.identities.current(req);
    if (!user.patient) throw new Error("PATIENT_PROFILE_REQUIRED");
    return this.database.client().patientProfile.update({ where: { id: user.patient.id }, data: patientPatch.parse(body) });
  }

  @Get("providers/me")
  async provider(@Req() req: AuthedRequest) {
    const user = await this.identities.current(req);
    if (!user.provider) throw new Error("PROVIDER_PROFILE_REQUIRED");
    return user.provider;
  }

  @Patch("providers/me")
  async updateProvider(@Req() req: AuthedRequest, @Body() body: unknown) {
    const user = await this.identities.current(req);
    if (!user.provider) throw new Error("PROVIDER_PROFILE_REQUIRED");
    return this.database.client().providerProfile.update({ where: { id: user.provider.id }, data: providerPatch.parse(body) });
  }

  @Post("providers/me/verification")
  @ApiOperation({ summary: "Submit a credential reference for out-of-band provider verification" })
  async submitVerification(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = verificationSchema.parse(body);
    const user = await this.identities.current(req);
    if (!user.provider) throw new Error("PROVIDER_PROFILE_REQUIRED");
    const verificationMetadataHash = createHash("sha256").update(JSON.stringify({ authority: input.authority, credentialReference: input.credentialReference })).digest("hex");
    return this.database.client().providerProfile.update({ where: { id: user.provider.id }, data: { verificationStatus: "SUBMITTED", verificationMetadataHash, stellarProviderRef: user.provider.stellarProviderRef ?? randomBytes(32).toString("hex") }, select: { id: true, verificationStatus: true, verificationMetadataHash: true, createdAt: true, updatedAt: true } });
  }

  private publicUser(user: Awaited<ReturnType<IdentityService["current"]>>) {
    return { id: user.id, wallet: user.authSubject, email: user.email, role: user.role, status: user.status, mfaState: user.mfaState, patient: user.patient, provider: user.provider };
  }
}
