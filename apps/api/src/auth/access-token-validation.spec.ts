import { listenOnLoopback } from "../common/testing/listen-loopback";
import "reflect-metadata";
import { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { GoogleOAuthService } from "./google-oauth.service";
import { AppleOAuthService } from "./apple-oauth.service";
import { StaffHandoffService } from "./handoff/staff-handoff.service";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { UsersController } from "../users/users.controller";
import { UsersService } from "../users/users.service";
import { AuditService } from "../audit/audit.service";
import { OperatorPermissionsService } from "./permissions/operator-permissions.service";

const SECRET = "access-token-validation-test-secret";

/**
 * HTTP-level pins: the real AuthController + UsersController behind the real JwtStrategy.
 * Only JwtAuthGuard-gated routes are probed; services are stubs so a rejected request must
 * leave every stub untouched.
 */
describe("access-token validation on JwtAuthGuard-only routes", () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: SECRET });
  const generateLinkUrl = jest.fn().mockResolvedValue("https://example.test/oauth");
  const linkAppleAccount = jest.fn().mockResolvedValue(undefined);
  const listSessions = jest.fn().mockResolvedValue([]);
  const findById = jest.fn().mockResolvedValue({ id: "u1" });

  const staffAccess = () =>
    jwt.sign(
      {
        sub: "u1",
        username: "alice",
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId: "t1",
        tenantSlug: "acme",
      },
      { expiresIn: "15m" },
    );
  const otherPurpose = () =>
    jwt.sign({ sub: "u1", tenantId: "t1", type: "email_verify" }, { expiresIn: "24h" });
  const roleless = () => jwt.sign({ sub: "u1" }, { expiresIn: "15m" });
  const unknownRole = () => jwt.sign({ sub: "u1", role: "GUEST" }, { expiresIn: "15m" });

  const routes: Array<[string, (t: string) => request.Test]> = [
    [
      "GET /auth/google/link",
      (t) => req().get("/auth/google/link").set("Authorization", `Bearer ${t}`),
    ],
    [
      "POST /auth/apple/link",
      (t) =>
        req()
          .post("/auth/apple/link")
          .set("Authorization", `Bearer ${t}`)
          .send({ identityToken: "x", nonce: "y" }),
    ],
    ["GET /auth/sessions", (t) => req().get("/auth/sessions").set("Authorization", `Bearer ${t}`)],
    ["GET /users/me", (t) => req().get("/users/me").set("Authorization", `Bearer ${t}`)],
  ];
  const req = () => request(app.getHttpServer());

  beforeAll(async () => {
    const config = {
      get: (k: string) => {
        if (k === "jwt") return { secret: SECRET };
        if (k === "WEB_URL") return "http://localhost:3001";
        return undefined;
      },
    };
    const mod = await Test.createTestingModule({
      imports: [PassportModule],
      controllers: [AuthController, UsersController],
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: config },
        { provide: AuthService, useValue: { listSessions } },
        {
          provide: GoogleOAuthService,
          useValue: { isConfigured: () => true, generateLinkUrl },
        },
        { provide: StaffHandoffService, useValue: {} },
        { provide: AppleOAuthService, useValue: { isConfigured: () => true, linkAppleAccount } },
        { provide: UsersService, useValue: { findById } },
        { provide: OperatorPermissionsService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } }, // NoImpersonationGuard (SA-778)
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it.each(routes)("%s accepts a staff access token", async (_n, call) => {
    await call(staffAccess()).expect((r) => expect(r.status).toBeLessThan(300));
  });

  it.each(routes)("%s rejects a non-session token shape", async (_n, call) => {
    await call(otherPurpose()).expect(401);
    expect(generateLinkUrl).not.toHaveBeenCalled();
    expect(linkAppleAccount).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it.each(routes)("%s rejects a token without a role", async (_n, call) => {
    await call(roleless()).expect(401);
  });

  it.each(routes)("%s rejects a token with an unknown role", async (_n, call) => {
    await call(unknownRole()).expect(401);
  });
});
