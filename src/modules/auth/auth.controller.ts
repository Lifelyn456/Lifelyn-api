import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
  ServiceUnavailableException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { Redis } from "ioredis";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { WalletAuth, type WalletChallenge } from "../../common/wallet-auth.js";
import { Public, SkipAuthorization } from "../../common/authorization.decorators.js";
const addressSchema = z.string().regex(/^G[A-Z2-7]{55}$/);
const challengeBody = z.object({ address: addressSchema }).strict();
const verifyBody = z
  .object({
    id: z.string().uuid(),
    address: addressSchema,
    signature: z.string().max(100),
  })
  .strict();
const origin = process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000";
let redis: Redis | undefined;
let auth: WalletAuth | undefined;
function config() {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32 || !process.env.REDIS_URL)
    throw new ServiceUnavailableException(
      "Wallet authentication is not configured yet.",
    );
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      retryStrategy: () => null,
    });
    redis.on("error", () => {
      /* Never log connection URLs or credentials. */
    });
  }
  const client = redis;
  auth ??= new WalletAuth(
    {
      async put(c, ttl) {
        await client.set(
          `auth:challenge:${c.id}`,
          JSON.stringify(c),
          "EX",
          ttl,
          "NX",
        );
      },
      async take(id) {
        const raw = await client.getdel(`auth:challenge:${id}`);
        return raw ? (JSON.parse(raw) as WalletChallenge) : null;
      },
    },
    origin,
  );
  return { auth, secret: new TextEncoder().encode(secret) };
}
@Controller("v1/auth")
export class AuthController {
  @Post("challenge")
  @Public()
  @ApiOperation({ summary: "Create a single-use Freighter sign-in challenge" })
  @ApiBody({
    schema: {
      type: "object",
      required: ["address"],
      properties: { address: { type: "string" } },
    },
  })
  @ApiResponse({
    status: 201,
    description: "Origin-bound challenge valid for five minutes",
  })
  async challenge(
    @Body() body: unknown,
    @Headers("origin") requestOrigin: string,
  ) {
    if (requestOrigin !== origin)
      throw new ForbiddenException("Origin is not permitted.");
    const parsed = challengeBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("A valid Stellar public key is required.");
    const { auth } = config();
    try {
      return await auth.challenge(parsed.data.address);
    } catch (error) {
      if (error instanceof Error && error.message === "INVALID_WALLET")
        throw new BadRequestException(
          "A valid Stellar public key is required.",
        );
      throw new ServiceUnavailableException(
        "Authentication storage is unavailable.",
      );
    }
  }
  @Post("verify")
  @Public()
  @ApiOperation({
    summary: "Verify a Freighter SEP-53 signature and consume the challenge",
  })
  @ApiBody({
    schema: {
      type: "object",
      required: ["id", "address", "signature"],
      properties: {
        id: { type: "string", format: "uuid" },
        address: { type: "string" },
        signature: { type: "string" },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description:
      "Short-lived wallet-identity token; does not confer clinical authorization",
  })
  async verify(
    @Body() body: unknown,
    @Headers("origin") requestOrigin: string,
  ) {
    if (requestOrigin !== origin)
      throw new ForbiddenException("Origin is not permitted.");
    const parsed = verifyBody.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException("Invalid signature response.");
    const { auth, secret } = config();
    try {
      const identity = await auth.verify(
        parsed.data.id,
        parsed.data.address,
        parsed.data.signature,
      );
      const token = await new SignJWT({
        wallet: identity.address,
        capability: "wallet_identity",
        mfa: false,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(identity.address)
        .setIssuer("lifelyn-api")
        .setAudience("lifelyn-web")
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(secret);
      return { token, expiresIn: 900 };
    } catch {
      throw new UnauthorizedException(
        "The signature or challenge is invalid, expired, or already used.",
      );
    }
  }
  @Get("me")
  @SkipAuthorization("Validates the wallet JWT itself (no WalletJwtGuard) and only ever echoes the caller's own identity; no patient-consent resource is touched.")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Read verified wallet identity without granting clinical access",
  })
  @ApiResponse({
    status: 200,
    description: "Wallet identity and security state",
  })
  async me(@Headers("authorization") authorization: string) {
    if (!authorization?.startsWith("Bearer "))
      throw new UnauthorizedException("Sign in with Freighter.");
    const { secret } = config();
    try {
      const { payload } = await jwtVerify(authorization.slice(7), secret, {
        issuer: "lifelyn-api",
        audience: "lifelyn-web",
        algorithms: ["HS256"],
      });
      if (typeof payload.wallet !== "string" || payload.wallet !== payload.sub)
        throw new Error("INVALID_IDENTITY");
      return {
        address: payload.wallet,
        mfa: payload.mfa === true,
        clinicalAccess: false,
      };
    } catch {
      throw new UnauthorizedException(
        "Your session has expired. Sign in again.",
      );
    }
  }
}
