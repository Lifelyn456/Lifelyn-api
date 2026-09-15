import { BadRequestException, Body, Controller, Post, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type AuthenticatorTransport, type RegistrationResponseJSON } from "@simplewebauthn/server";
import { Redis } from "ioredis";
import { SignJWT } from "jose";
import { WalletJwtGuard, type AuthedRequest } from "../../common/auth-context.js";
import { DatabaseService } from "../../common/database.service.js";
import { IdentityService } from "../../common/identity.service.js";

type Ceremony = { challenge: string; kind: "register" | "authenticate" };

@Controller("v1/auth/mfa")
@ApiBearerAuth()
@UseGuards(WalletJwtGuard)
export class MfaController {
  private redis?: Redis;
  constructor(private readonly database: DatabaseService, private readonly identities: IdentityService) {}

  @Post("register/options")
  @ApiOperation({ summary: "Create provider passkey-enrollment options after Freighter login" })
  async registerOptions(@Req() req: AuthedRequest) {
    const user = await this.identities.current(req);
    if (!user.provider) throw new BadRequestException("MFA enrollment is required only for provider accounts.");
    const passkeys = await this.database.client().passkeyCredential.findMany({ where: { userId: user.id } });
    const options = await generateRegistrationOptions({ rpName: "Lifelyn", rpID: this.rpId(), userID: new TextEncoder().encode(user.id), userName: user.authSubject, attestationType: "none", excludeCredentials: passkeys.map((key) => ({ id: key.credentialId, transports: key.transports as AuthenticatorTransport[] })), authenticatorSelection: { residentKey: "required", userVerification: "required" }, supportedAlgorithmIDs: [-7, -257] });
    await this.store(user.id, { challenge: options.challenge, kind: "register" });
    return options;
  }

  @Post("register/verify")
  async registerVerify(@Req() req: AuthedRequest, @Body() body: RegistrationResponseJSON) {
    const user = await this.identities.current(req);
    if (!user.provider) throw new BadRequestException("A provider profile is required.");
    const ceremony = await this.take(user.id, "register");
    const verification = await verifyRegistrationResponse({ response: body, expectedChallenge: ceremony.challenge, expectedOrigin: this.origin(), expectedRPID: this.rpId(), requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
    if (!verification.verified || !verification.registrationInfo) throw new BadRequestException("Passkey registration could not be verified.");
    const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
    await this.database.client().$transaction([
      this.database.client().passkeyCredential.create({ data: { userId: user.id, credentialId: credential.id, publicKey: Buffer.from(credential.publicKey), counter: BigInt(credential.counter), transports: credential.transports ?? [], deviceType: credentialDeviceType, backedUp: credentialBackedUp } }),
      this.database.client().user.update({ where: { id: user.id }, data: { mfaState: "ENROLLED" } }),
    ]);
    return { verified: true, mfaState: "ENROLLED" };
  }

  @Post("authenticate/options")
  async authenticationOptions(@Req() req: AuthedRequest) {
    const user = await this.identities.current(req);
    const passkeys = await this.database.client().passkeyCredential.findMany({ where: { userId: user.id } });
    if (!passkeys.length) throw new BadRequestException("Enroll a passkey before requesting provider access.");
    const options = await generateAuthenticationOptions({ rpID: this.rpId(), allowCredentials: passkeys.map((key) => ({ id: key.credentialId, transports: key.transports as AuthenticatorTransport[] })), userVerification: "required" });
    await this.store(user.id, { challenge: options.challenge, kind: "authenticate" });
    return options;
  }

  @Post("authenticate/verify")
  async authenticationVerify(@Req() req: AuthedRequest, @Body() body: AuthenticationResponseJSON) {
    const user = await this.identities.current(req);
    const ceremony = await this.take(user.id, "authenticate");
    const passkey = await this.database.client().passkeyCredential.findFirst({ where: { userId: user.id, credentialId: body.id } });
    if (!passkey) throw new BadRequestException("Registered passkey was not found.");
    const verification = await verifyAuthenticationResponse({ response: body, expectedChallenge: ceremony.challenge, expectedOrigin: this.origin(), expectedRPID: this.rpId(), credential: { id: passkey.credentialId, publicKey: new Uint8Array(passkey.publicKey), counter: Number(passkey.counter), transports: passkey.transports as AuthenticatorTransport[] }, requireUserVerification: true });
    if (!verification.verified) throw new BadRequestException("Passkey verification failed.");
    await this.database.client().passkeyCredential.update({ where: { id: passkey.id }, data: { counter: BigInt(verification.authenticationInfo.newCounter) } });
    const rawSecret = process.env.AUTH_JWT_SECRET;
    if (!rawSecret || Buffer.byteLength(rawSecret) < 32) throw new ServiceUnavailableException("Wallet authentication is not configured.");
    const token = await new SignJWT({ wallet: user.authSubject, capability: "wallet_identity", mfa: true }).setProtectedHeader({ alg: "HS256" }).setSubject(user.authSubject).setIssuer("lifelyn-api").setAudience("lifelyn-web").setIssuedAt().setExpirationTime("15m").sign(new TextEncoder().encode(rawSecret));
    return { verified: true, token, expiresIn: 900 };
  }

  private origin() { return process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000"; }
  private rpId() { return process.env.WEBAUTHN_RP_ID ?? new URL(this.origin()).hostname; }
  private client() {
    if (!process.env.REDIS_URL) throw new ServiceUnavailableException("MFA challenge storage is not configured.");
    this.redis ??= new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
    return this.redis;
  }
  private async store(userId: string, value: Ceremony) { await this.client().set(`mfa:${value.kind}:${userId}`, JSON.stringify(value), "EX", 300); }
  private async take(userId: string, kind: Ceremony["kind"]) {
    const value = await this.client().getdel(`mfa:${kind}:${userId}`);
    if (!value) throw new BadRequestException("MFA challenge is invalid, expired, or already used.");
    const ceremony = JSON.parse(value) as Ceremony;
    if (ceremony.kind !== kind) throw new BadRequestException("MFA challenge is invalid.");
    return ceremony;
  }
}
