import { Controller, Get, Module } from "@nestjs/common";
import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AuthController } from "./modules/auth/auth.controller.js";
import { RecordsController } from "./modules/records/records.controller.js";
import { ObjectStorageService } from "./modules/records/object-storage.service.js";
import { AuditController } from "./modules/audit/audit.controller.js";
import { FhirController } from "./modules/fhir/fhir.controller.js";
import { AiClient } from "./integrations/ai-client.js";
import { StellarAdapter } from "./integrations/stellar.js";
import { WalletJwtGuard } from "./common/auth-context.js";
import { ConsentController } from "./modules/consent/consent.controller.js";
import { DatabaseService } from "./common/database.service.js";
import { IdentityService } from "./common/identity.service.js";
import { AuthorizationService } from "./common/authorization.service.js";
import { FieldCryptoService } from "./common/field-crypto.service.js";
import { EnvironmentKeyWrapper, MalwareScanner } from "./modules/records/object-storage.service.js";
import { JobsService } from "./modules/jobs/jobs.service.js";
import { ProfilesController } from "./modules/profiles/profiles.controller.js";
import { TimelineController } from "./modules/timeline/timeline.controller.js";
import { AskController } from "./modules/ask/ask.controller.js";
import { MfaController } from "./modules/auth/mfa.controller.js";
import { ProviderVerificationController } from "./modules/providers/provider-verification.controller.js";
import { OrganizationsController } from "./modules/organizations/organizations.controller.js";
import { OrganizationVerificationController } from "./modules/organizations/organization-verification.controller.js";
import { AuthorizationEnforcementInterceptor } from "./common/authorization.enforcement.interceptor.js";
import { Public } from "./common/authorization.decorators.js";

@Controller("v1/health")
export class HealthController {
  @Get()
  @Public()
  @ApiOperation({ summary: "Process liveness only; not dependency readiness" })
  @ApiResponse({ status: 200, description: "Process is running" })
  health() {
    return { status: "ok", service: "lifelyn-api", schemaVersion: "1.0" };
  }
}

@Module({
  controllers: [HealthController, AuthController, MfaController, ProviderVerificationController, OrganizationsController, OrganizationVerificationController, ProfilesController, RecordsController, TimelineController, AskController, AuditController, FhirController, ConsentController],
  providers: [
    DatabaseService,
    IdentityService,
    AuthorizationService,
    FieldCryptoService,
    EnvironmentKeyWrapper,
    MalwareScanner,
    ObjectStorageService,
    JobsService,
    AiClient,
    StellarAdapter,
    WalletJwtGuard,
    Reflector,
    { provide: APP_INTERCEPTOR, useClass: AuthorizationEnforcementInterceptor },
  ],
})
export class AppModule {}
