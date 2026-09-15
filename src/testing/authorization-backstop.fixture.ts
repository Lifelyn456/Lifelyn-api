import { Controller, Get, Module } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { AuthorizationEnforcementInterceptor } from "../common/authorization.enforcement.interceptor.js";
import { Public, RequiresAuthorization } from "../common/authorization.decorators.js";

/**
 * Test-only fixture proving AuthorizationEnforcementInterceptor's fail-closed behavior in
 * isolation from DatabaseService. Lives under src/ (not test/) solely because Vite's test
 * transform for this project only applies experimentalDecorators/emitDecoratorMetadata to
 * files matched by tsconfig.json's "include" (src/**); it is never imported by AppModule and
 * has no effect on the running service. See test/authorization.e2e.test.ts.
 */
@Controller("test")
export class UndecidedController {
  @Get("undecided")
  undecided() {
    return { ok: true };
  }

  @Get("public")
  @Public()
  isPublic() {
    return { ok: true };
  }

  @Get("forgotten")
  @RequiresAuthorization()
  forgotten() {
    // A future developer marks a route @RequiresAuthorization() but forgets to actually
    // call AuthorizationService.assert() — this must fail loudly, not silently serve data.
    return { ok: true };
  }
}

@Module({
  controllers: [UndecidedController],
  providers: [Reflector, { provide: APP_INTERCEPTOR, useClass: AuthorizationEnforcementInterceptor }],
})
export class BackstopTestModule {}
