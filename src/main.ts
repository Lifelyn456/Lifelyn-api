import "reflect-metadata";
import "dotenv/config";
import { Module, Controller, Get } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import {
  DocumentBuilder,
  SwaggerModule,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { AuthController } from "./modules/auth/auth.controller.js";
import { SafeExceptionFilter } from "./common/errors.js";
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
import { assertProductionConfiguration } from "./common/production-config.js";

assertProductionConfiguration();
@Controller("v1/health")
class HealthController {
  @Get()
  @ApiOperation({ summary: "Process liveness only; not dependency readiness" })
  @ApiResponse({ status: 200, description: "Process is running" })
  health() {
    return { status: "ok", service: "lifelyn-api", schemaVersion: "1.0" };
  }
}
@Module({
  controllers: [HealthController, AuthController, MfaController, ProviderVerificationController, ProfilesController, RecordsController, TimelineController, AskController, AuditController, FhirController, ConsentController],
  providers: [DatabaseService, IdentityService, AuthorizationService, FieldCryptoService, EnvironmentKeyWrapper, MalwareScanner, ObjectStorageService, JobsService, AiClient, StellarAdapter, WalletJwtGuard],
})
class AppModule {}
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({
    logger: {
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
      ],
    },
    bodyLimit: 1048576,
  }),
);
await app.register(helmet);
await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
app.useGlobalFilters(new SafeExceptionFilter());
app.enableCors({
  origin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000",
  credentials: false,
});
const document = SwaggerModule.createDocument(
  app,
  new DocumentBuilder()
    .setTitle("Lifelyn API")
    .setDescription(
      "Live wallet-authenticated patient memory API. Protected operations fail closed when a required production dependency is unavailable.",
    )
    .setVersion("1.0")
    .addBearerAuth()
    .build(),
);
SwaggerModule.setup("openapi", app, document);
await app.listen(Number(process.env.PORT ?? 4000), process.env.HOST ?? "0.0.0.0");
