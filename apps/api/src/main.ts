import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json } from "express";
import helmet from "helmet";
import { Pool } from "pg";
import { AppModule } from "./app.module";
import { RedisIoAdapter } from "./gateways/redis-io.adapter";
import { ThrottlerExceptionFilter } from "./common/throttler-exception.filter";

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
  const missing: string[] = [];
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");
  if (!process.env.JWT_REFRESH_SECRET) missing.push("JWT_REFRESH_SECRET");
  if (missing.length > 0) {
    console.error(`\n❌ FATAL: Missing required environment variables: ${missing.join(", ")}`);
    console.error("   JWT secrets must be set in ALL environments (including development).\n");
    process.exit(1);
  }

  // F5-001/F5-002: warn (do NOT crash) when production-recommended secrets are
  // unset. ENCRYPTION_KEY missing → encrypt() is disabled in prod; STORAGE_URL_
  // SIGNING_SECRET missing → the key is derived from JWT_SECRET via HKDF.
  if (process.env.NODE_ENV === "production") {
    const warn: string[] = [];
    const encKey = process.env.ENCRYPTION_KEY ?? "";
    if (encKey.length !== 64) warn.push("ENCRYPTION_KEY (expected 64 hex chars)");
    if (!process.env.STORAGE_URL_SIGNING_SECRET)
      warn.push("STORAGE_URL_SIGNING_SECRET (deriving from JWT_SECRET)");
    if (warn.length > 0) {
      console.warn(`\n⚠️  Production secrets not fully configured: ${warn.join(", ")}\n`);
    }
  }
}

/** Idempotent startup migrations — runs before NestJS boots. */
async function runStartupMigration() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(
      `ALTER TABLE "TenantConfig"
         ADD COLUMN IF NOT EXISTS "invoiceNotes" TEXT,
         ADD COLUMN IF NOT EXISTS "invoiceTerms" TEXT`,
    );
    // Emergency 20260623: unlisted items + shipment tracking columns
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'OrderItem' AND column_name = 'productId' AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE "OrderItem" ALTER COLUMN "productId" DROP NOT NULL;
        END IF;
      END $$;
      ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "name" TEXT;
      ALTER TABLE "Order"
        ADD COLUMN IF NOT EXISTS "shippingCarrier"        TEXT,
        ADD COLUMN IF NOT EXISTS "shippingTrackingNumber" TEXT,
        ADD COLUMN IF NOT EXISTS "shippedAt"              TIMESTAMP(3);
      ALTER TABLE "Invoice"
        ADD COLUMN IF NOT EXISTS "shippingCarrier"        TEXT,
        ADD COLUMN IF NOT EXISTS "shippingTrackingNumber" TEXT,
        ADD COLUMN IF NOT EXISTS "shippedAt"              TIMESTAMP(3)
    `);
    console.log("✅ Startup migrations applied");
  } catch (err) {
    console.warn("⚠️  Startup migration error:", (err as Error).message);
  } finally {
    await pool.end();
  }
}

async function bootstrap() {
  await runStartupMigration();
  assertSecrets();
  const app = await NestFactory.create(AppModule, {
    // rawBody: true preserves req.rawBody for Stripe webhook signature verification
    rawBody: true,
  });

  // ─── Proxy trust ──────────────────────────────────────────────────────────────
  // Railway sits behind two proxy hops: Railway's own load balancer (hop 1)
  // and the Fastly CDN edge (hop 2). Without trusting both hops, Express uses
  // the rotating Fastly edge IP as req.ip, which makes per-IP rate limiting
  // useless (each request from the same client appears to come from a
  // different Fastly node and gets its own counter).
  // trust proxy = 2 skips both hops → req.ip = real client IP from XFF.
  app.getHttpAdapter().getInstance().set("trust proxy", 2);

  // ─── Security headers (helmet) ──────────────────────────────────────────────
  app.use(helmet());

  // ─── Body size limit ────────────────────────────────────────────────────────
  // 2mb covers all regular payloads. Bulk-import endpoints that need more
  // should stream uploads to object storage (R2/S3) directly.
  app.use(json({ limit: "2mb" }));

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
      // Any localhost port is allowed in development
      if (/^http:\/\/localhost:\d+$/.test(origin)) return callback(null, true);
      // Wildcard subdomain patterns — e.g. *.routeflow.io, *.routeflow.app
      if (wildcardPatterns.some((p) => p.test(origin))) return callback(null, true);
      callback(new Error(`CORS: origin '${origin}' not allowed`));
    },
    credentials: true,
  });

  // ─── Global exception filters ────────────────────────────────────────────────
  // RF-160: emit Retry-After header on 429 throttle responses
  app.useGlobalFilters(new ThrottlerExceptionFilter());

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

    // Redirect bare root to Swagger UI
    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.get("/", (_req: any, res: any) => res.redirect("/api/docs"));
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
