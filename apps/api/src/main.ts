import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json } from "express";
import { AppModule } from "./app.module";
import { RedisIoAdapter } from "./gateways/redis-io.adapter";

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3001", // web dashboard
  "http://localhost:8081", // Expo web
  "http://localhost:19000", // Expo DevTools
  "http://localhost:19006", // Expo web (legacy)
];

// In production set these env vars:
//   CORS_ORIGINS=https://app.routeflow.io,https://routeflow.up.railway.app
//   CORS_WILDCARD_DOMAINS=routeflow.io,routeflow.app
// Any subdomain of CORS_WILDCARD_DOMAINS is then allowed automatically.

function buildWildcardPatterns(): RegExp[] {
  const raw = process.env.CORS_WILDCARD_DOMAINS ?? "";
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((domain) => {
      const escaped = domain.replace(/\./g, "\\.");
      return new RegExp(`^https?:\\/\\/[a-z0-9][a-z0-9-]*\\.${escaped}$`);
    });
}

function assertSecrets() {
  const isProd = process.env.NODE_ENV === "production";
  const missing: string[] = [];
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
  if (!process.env.JWT_REFRESH_SECRET) missing.push("JWT_REFRESH_SECRET");
  if (isProd && missing.length > 0) {
    console.error(`\n❌ FATAL: Missing required environment variables: ${missing.join(", ")}`);
    console.error("   Refusing to start in production with empty JWT secrets.\n");
    process.exit(1);
  } else if (missing.length > 0) {
    console.warn(`\n⚠️  WARNING: ${missing.join(", ")} not set — using empty string (dev only).\n`);
  }
}

async function bootstrap() {
  assertSecrets();
  const app = await NestFactory.create(AppModule, {
    // rawBody: true preserves req.rawBody for Stripe webhook signature verification
    rawBody: true,
  });

  // ─── Proxy trust (Railway / Heroku / etc. sit behind a load balancer) ────────
  // Without this, ThrottlerGuard sees the proxy's IP for every request instead
  // of the real client IP, making per-IP rate limiting ineffective.
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // ─── Body size limit (default 100kb is too small for bulk imports) ───────────
  app.use(json({ limit: "10mb" }));

  // ─── WebSocket adapter (Redis pub/sub) ──────────────────────────────────────
  app.useWebSocketAdapter(new RedisIoAdapter(app));

  // ─── Global prefix ──────────────────────────────────────────────────────────
  app.setGlobalPrefix("api/v1");

  // ─── CORS ───────────────────────────────────────────────────────────────────
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
    : DEFAULT_CORS_ORIGINS;

  const wildcardPatterns = buildWildcardPatterns();

  app.enableCors({
    origin: (origin, callback) => {
      // Allow server-to-server calls (no Origin) and same-origin requests
      if (!origin) return callback(null, true);
      // Exact allow-list (explicit origins + localhost defaults)
      if (corsOrigins.includes(origin)) return callback(null, true);
      // Wildcard subdomain patterns — e.g. *.routeflow.io, *.routeflow.app
      if (wildcardPatterns.some((p) => p.test(origin))) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  });

  // ─── Validation ─────────────────────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // ─── Swagger (dev / staging only) ───────────────────────────────────────────
  if (process.env.NODE_ENV !== "production") {
    const config = new DocumentBuilder()
      .setTitle("RouteFlow API")
      .setDescription("REST API for the RouteFlow delivery management platform")
      .setVersion("1.0")
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/docs", app, document);
  }

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  console.log(`🚀 RouteFlow API listening on http://localhost:${port}/api/v1`);
  if (process.env.NODE_ENV !== "production") {
    console.log(`📄 Swagger UI at http://localhost:${port}/api/docs`);
  }
}
bootstrap();
