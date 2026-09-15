import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable, tap } from "rxjs";
import { AppException } from "./errors.js";
import { PUBLIC_KEY, REQUIRES_AUTHORIZATION_KEY, SKIP_AUTHORIZATION_KEY } from "./authorization.decorators.js";
import type { AuthedRequest } from "./auth-context.js";

/**
 * Structural backstop for PRD section 9's authorization order: every route must declare its
 * authorization stance (@Public, @SkipAuthorization, or @RequiresAuthorization), and any route
 * declaring @RequiresAuthorization must actually invoke AuthorizationService.assert() while
 * handling the request. A route that forgets either one fails closed with a 500 instead of
 * silently serving consent-gated data — this cannot be bypassed by a future handler simply
 * neglecting to call the service.
 */
@Injectable()
export class AuthorizationEnforcementInterceptor implements NestInterceptor {
  // Explicit @Inject(Reflector) rather than relying on implicit constructor-parameter-type
  // metadata: esbuild-based dev runners (tsx, used by `pnpm dev`) do not emit
  // `emitDecoratorMetadata`'s design:paramtypes for framework types, which silently left
  // `this.reflector` undefined and crashed every request with a 500 as soon as it passed its
  // guards. `tsc` (used by `pnpm build`/production) emits it correctly, which is why this only
  // ever surfaced in local dev. The explicit token below works under both compilers.
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();
    const handler = context.getHandler();
    const controller = context.getClass();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [handler, controller]);
    if (isPublic) return next.handle();
    const skipReason = this.reflector.getAllAndOverride<string>(SKIP_AUTHORIZATION_KEY, [handler, controller]);
    const requiresAuthorization = this.reflector.getAllAndOverride<boolean>(REQUIRES_AUTHORIZATION_KEY, [handler, controller]);
    const label = `${controller.name}.${String(handler.name)}`;
    if (!skipReason && !requiresAuthorization) {
      throw new AppException(
        "AUTHORIZATION_STANCE_UNDECLARED",
        `${label} declares no authorization stance (@Public, @SkipAuthorization, or @RequiresAuthorization). Refusing to serve the request.`,
        500,
      );
    }
    if (skipReason) return next.handle();
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    return next.handle().pipe(
      tap(() => {
        if (!req.authorizationChecked) {
          throw new AppException(
            "AUTHORIZATION_NOT_ENFORCED",
            `${label} is marked @RequiresAuthorization but completed without calling AuthorizationService.assert().`,
            500,
          );
        }
      }),
    );
  }
}
