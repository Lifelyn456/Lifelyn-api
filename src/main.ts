import "reflect-metadata";
import "dotenv/config";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import {
  DocumentBuilder,
  SwaggerModule,
} from "@nestjs/swagger";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { SafeExceptionFilter } from "./common/errors.js";
import { assertProductionConfiguration } from "./common/production-config.js";
import { AppModule } from "./app.module.js";

assertProductionConfiguration();
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
// CORS must be registered before rate-limit: Fastify hooks run in registration
// order, and rate-limit's onRequest hook can short-circuit a request with a 429
// before a later-registered CORS hook ever adds Access-Control-Allow-Origin. A
// rate-limited response missing that header is opaque to the browser, which
// reports it to calling code as a generic "Failed to fetch" network error
// rather than a readable 429 — indistinguishable from a real outage.
app.enableCors({
  origin: process.env.WEB_ORIGIN ?? "http://127.0.0.1:3000",
  credentials: false,
});
await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
app.useGlobalFilters(new SafeExceptionFilter());
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
