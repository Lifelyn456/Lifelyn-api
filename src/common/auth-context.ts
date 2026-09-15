import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { jwtVerify } from "jose";

export type RequestActor = { wallet: string; subject: string; capability: string; mfa: boolean };
export type AuthedRequest = { headers: { authorization?: string }; id?: string; actor?: RequestActor };

@Injectable()
export class WalletJwtGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const raw = req.headers.authorization;
    if (!raw?.startsWith("Bearer ")) throw new UnauthorizedException("Wallet session required.");
    const secret = process.env.AUTH_JWT_SECRET;
    if (!secret || Buffer.byteLength(secret) < 32) throw new UnauthorizedException("Wallet authentication is not configured.");
    try {
      const { payload } = await jwtVerify(raw.slice(7), new TextEncoder().encode(secret), { issuer: "lifelyn-api", audience: "lifelyn-web", algorithms: ["HS256"] });
      if (typeof payload.wallet !== "string" || typeof payload.sub !== "string" || payload.wallet !== payload.sub || payload.capability !== "wallet_identity") throw new Error("identity");
      req.actor = { wallet: payload.wallet, subject: payload.sub, capability: String(payload.capability ?? "wallet_identity"), mfa: payload.mfa === true };
      return true;
    } catch {
      throw new UnauthorizedException("Wallet session is invalid or expired.");
    }
  }
}
