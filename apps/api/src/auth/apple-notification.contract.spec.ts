/**
 * Sign in with Apple server-to-server notifications arrive as JSON `{ "payload": "<JWT>" }`
 * (Apple's "Sign in with Apple" REST contract — NOT the App Store's `signedPayload`). The global
 * ValidationPipe whitelists + forbids unknown properties (main.ts), so a DTO that only knows
 * `signedPayload` would 400 every real notification and consent-revoked / account-delete events
 * would never be processed. This spec posts the real body shape through the same pipe.
 */
import "reflect-metadata";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AuthController } from "./auth.controller";
import { listenOnLoopback } from "../common/testing/listen-loopback";

describe("POST /auth/apple/notifications — real body shape (SA-418)", () => {
  let app: INestApplication;
  const handleNotification = jest.fn().mockResolvedValue(undefined);
  const apple = {
    isNotificationConfigured: jest.fn().mockReturnValue(true),
    handleNotification,
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: "AuthService", useValue: {} }],
    })
      .useMocker((token) => {
        const name = typeof token === "function" ? token.name : String(token);
        if (name === "AppleOAuthService") return apple;
        if (name === "ConfigService") return { get: () => undefined };
        return {};
      })
      .compile();
    app = mod.createNestApplication();
    // Same global pipe as main.ts.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await listenOnLoopback(app);
  });

  afterAll(() => app.close());
  beforeEach(() => {
    handleNotification.mockClear();
    apple.isNotificationConfigured.mockReturnValue(true);
  });

  it("accepts Apple's `payload` field and hands the JWS to the service", async () => {
    await request(app.getHttpServer())
      .post("/auth/apple/notifications")
      .send({ payload: "eyJ.header.sig" })
      .expect(200, { received: true });
    expect(handleNotification).toHaveBeenCalledWith("eyJ.header.sig");
  });

  it("still accepts the legacy `signedPayload` name (older callers/tests)", async () => {
    await request(app.getHttpServer())
      .post("/auth/apple/notifications")
      .send({ signedPayload: "eyJ.legacy.sig" })
      .expect(200);
    expect(handleNotification).toHaveBeenCalledWith("eyJ.legacy.sig");
  });

  it("rejects an empty body and a non-string payload with 400 (and calls nothing)", async () => {
    await request(app.getHttpServer()).post("/auth/apple/notifications").send({}).expect(400);
    await request(app.getHttpServer())
      .post("/auth/apple/notifications")
      .send({ payload: 5 })
      .expect(400);
    expect(handleNotification).not.toHaveBeenCalled();
  });

  it("both fields: payload wins; extra properties and a null signedPayload are 400/ignored per the pipe", async () => {
    await request(app.getHttpServer())
      .post("/auth/apple/notifications")
      .send({ payload: "eyJ.p.sig", signedPayload: "eyJ.s.sig" })
      .expect(200);
    expect(handleNotification).toHaveBeenLastCalledWith("eyJ.p.sig");
    await request(app.getHttpServer())
      .post("/auth/apple/notifications")
      .send({ payload: "eyJ.p.sig", extra: 1 })
      .expect(400);
    handleNotification.mockClear();
    await request(app.getHttpServer())
      .post("/auth/apple/notifications")
      .send({ signedPayload: null })
      .expect(400);
    expect(handleNotification).not.toHaveBeenCalled();
  });

  it("the unauthenticated notifications route carries its own throttle (not just the global default)", () => {
    const handler = AuthController.prototype.appleNotifications;
    expect(Reflect.getMetadata("THROTTLER:LIMITdefault", handler)).toBeLessThanOrEqual(30);
    expect(Reflect.getMetadata("THROTTLER:TTLdefault", handler)).toBeGreaterThanOrEqual(60_000);
  });

  it("unconfigured: a readable 503, never a crash", async () => {
    apple.isNotificationConfigured.mockReturnValue(false);
    const res = await request(app.getHttpServer())
      .post("/auth/apple/notifications")
      .send({ payload: "eyJ.header.sig" })
      .expect(503);
    expect(JSON.stringify(res.body)).toMatch(/not configured/i);
    expect(handleNotification).not.toHaveBeenCalled();
  });
});
