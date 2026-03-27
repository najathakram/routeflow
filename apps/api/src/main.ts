import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { RedisIoAdapter } from "./gateways/redis-io.adapter";

const DEFAULT_CORS_ORIGINS = [
  "http://localhost:3001", // web dashboard
  "http://localhost:8081", // Expo web
  "http://localhost:19000", // Expo DevTools
  "http://localhost:19006", // Expo web (legacy)
];

// In production CORS_ORIGINS env var overrides defaults:
//   CORS_ORIGINS=https://routeflow.up.railway.app,https://your-custom-domain.com

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ─── WebSocket adapter (Redis pub/sub) ──────────────────────────────────────
  app.useWebSocketAdapter(new RedisIoAdapter(app));

  // ─── Global prefix ──────────────────────────────────────────────────────────
  app.setGlobalPrefix("api/v1");

  // ─── CORS ───────────────────────────────────────────────────────────────────
  const corsOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
    : DEFAULT_CORS_ORIGINS;

  app.enableCors({
    origin: corsOrigins,
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

  // ─── Health check (Railway / load balancers) ────────────────────────────────
  app.getHttpAdapter().get("/health", (_req: unknown, res: { send: (s: string) => void }) => res.send("ok"));

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
