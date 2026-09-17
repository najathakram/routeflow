import { ForbiddenException, BadRequestException, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import request from "supertest";
import { MailboxController } from "./mailbox.controller";
import { MailboxConnectionService } from "./mailbox-connection.service";
import { JwtStrategy } from "../../auth/strategies/jwt.strategy";
import { JwtAuthGuard } from "../../auth/guards/jwt-auth.guard";
import { RolesGuard } from "../../auth/guards/roles.guard";
import { AddonGuard } from "../../billing/addon.guard";
import { AddonService } from "../../billing/addon.service";
import { EntitlementsService } from "../../billing/entitlements.service";
import { FeatureOverrideService } from "../../billing/feature-override.service";

/**
 * HTTP-level, real-guard-chain tests for MailboxController (security review fix round —
 * "another user or tenant confirming gets 403; a replayed state gets 400; a non-admin gets
 * 403 — these are HTTP-level e2e-style controller tests with real guards"). Unlike every other
 * spec in this codebase (which mocks guards at the module boundary — see
 * `addon-guard-module-import.spec.ts`'s header), this one builds a real `JwtStrategy` +
 * `JwtAuthGuard` + `RolesGuard` + `AddonGuard` and drives them over real HTTP via `supertest`
 * and a real signed JWT — the ONLY thing mocked is `MailboxConnectionService` itself (its own
 * business logic — the identity-mismatch/replay checks — is covered for real in
 * `mailbox-connection.service.spec.ts`; this file proves the CONTROLLER wires a real JWT's
 * identity through the guard chain correctly, and that the guard chain itself denies the right
 * requests).
 */
describe("MailboxController — real guard chain over HTTP", () => {
  const JWT_SECRET = "mailbox-controller-security-spec-secret";
  let app: INestApplication;
  let jwtService: JwtService;
  let mailboxConnection: {
    getStatus: jest.Mock;
    startConnect: jest.Mock;
    confirmConnect: jest.Mock;
    disconnect: jest.Mock;
  };

  function signToken(payload: {
    sub: string;
    role: "TENANT_ADMIN" | "OPERATOR" | "DRIVER";
    tenantId: string | null;
  }): string {
    return jwtService.sign({
      sub: payload.sub,
      username: `user-${payload.sub}`,
      role: payload.role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: payload.tenantId,
      tenantSlug: payload.tenantId ? `${payload.tenantId}-slug` : null,
    });
  }

  beforeAll(async () => {
    mailboxConnection = {
      getStatus: jest.fn().mockResolvedValue({ configured: true, connected: false }),
      startConnect: jest
        .fn()
        .mockResolvedValue("https://accounts.google.com/o/oauth2/v2/auth?mock=1"),
      // Simulates the REAL confirmConnect identity rule (unit-tested for real in
      // mailbox-connection.service.spec.ts) — proves the controller passes the CALLER's own
      // JWT identity through, not a hardcoded/omitted one.
      confirmConnect: jest.fn(async (state: string, userId: string, tenantId: string) => {
        if (state === "already-used-token") throw new BadRequestException("state_invalid");
        if (userId !== "admin-1" || tenantId !== "tenant-a") {
          throw new ForbiddenException("mailbox_confirm_identity_mismatch");
        }
        return { configured: true, connected: true, accountEmail: "owner@acme.test" };
      }),
      disconnect: jest.fn().mockResolvedValue({ deleted: true }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [PassportModule, JwtModule.register({ secret: JWT_SECRET })],
      controllers: [MailboxController],
      providers: [
        JwtStrategy,
        JwtAuthGuard,
        RolesGuard,
        AddonGuard,
        Reflector,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              ({ jwt: { secret: JWT_SECRET }, WEB_URL: "http://localhost:3001" })[key],
          },
        },
        // email.connected_mailbox is registered `dark` — AddonGuard allows through
        // regardless of grant, so a bare empty grant list is the realistic fixture.
        { provide: AddonService, useValue: { getActiveAddons: jest.fn().mockResolvedValue([]) } },
        {
          provide: EntitlementsService,
          useValue: { isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false) },
        },
        // Feature grants PR-1 (already on master): AddonGuard gained a 4th constructor
        // dependency. An empty override map = no active GRANT/DENY, same as the pre-PR-1
        // behavior this fixture models.
        {
          provide: FeatureOverrideService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: MailboxConnectionService, useValue: mailboxConnection },
      ],
    }).compile();

    jwtService = moduleRef.get(JwtService);
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  // ── unauthenticated ────────────────────────────────────────────────────────

  it("no Authorization header: every guarded route 401s", async () => {
    await request(app.getHttpServer()).get("/settings/email/mailbox").expect(401);
    await request(app.getHttpServer()).get("/settings/email/mailbox/google/start").expect(401);
    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .send({ state: "x" })
      .expect(401);
    await request(app.getHttpServer()).delete("/settings/email/mailbox").expect(401);
  });

  // ── non-admin (RolesGuard) ─────────────────────────────────────────────────

  it("a non-admin (OPERATOR) JWT gets 403 on every TENANT_ADMIN route", async () => {
    const token = signToken({ sub: "op-1", role: "OPERATOR", tenantId: "tenant-a" });

    await request(app.getHttpServer())
      .get("/settings/email/mailbox")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    await request(app.getHttpServer())
      .get("/settings/email/mailbox/google/start")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ state: "x" })
      .expect(403);
    await request(app.getHttpServer())
      .delete("/settings/email/mailbox")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);

    expect(mailboxConnection.confirmConnect).not.toHaveBeenCalled();
  });

  // ── TENANT_ADMIN happy path (guard chain lets it through) ─────────────────

  it("a TENANT_ADMIN JWT passes the real guard chain on every route", async () => {
    const token = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    await request(app.getHttpServer())
      .get("/settings/email/mailbox")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get("/settings/email/mailbox/google/start")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .delete("/settings/email/mailbox")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  });

  // ── confirm: identity mismatch -> 403, replay -> 400 (the HIGH fix itself) ─

  it("confirm: another TENANT_ADMIN (different userId, same tenant) confirming gets 403 — the real JWT identity is what's checked, not a client-supplied one", async () => {
    const otherAdminToken = signToken({
      sub: "admin-2",
      role: "TENANT_ADMIN",
      tenantId: "tenant-a",
    });

    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${otherAdminToken}`)
      .send({ state: "pending-grant-token" })
      .expect(403);

    expect(mailboxConnection.confirmConnect).toHaveBeenCalledWith(
      "pending-grant-token",
      "admin-2",
      "tenant-a",
    );
  });

  it("confirm: the RIGHT userId but a DIFFERENT tenantId confirming gets 403", async () => {
    const crossTenantToken = signToken({
      sub: "admin-1",
      role: "TENANT_ADMIN",
      tenantId: "tenant-b",
    });

    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${crossTenantToken}`)
      .send({ state: "pending-grant-token" })
      .expect(403);

    expect(mailboxConnection.confirmConnect).toHaveBeenCalledWith(
      "pending-grant-token",
      "admin-1",
      "tenant-b",
    );
  });

  it("confirm: the matching TENANT_ADMIN succeeds", async () => {
    const rightToken = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    const res = await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${rightToken}`)
      .send({ state: "pending-grant-token" })
      .expect(200);

    expect(res.body).toMatchObject({ connected: true, accountEmail: "owner@acme.test" });
  });

  it("confirm: a replayed/already-consumed state gets 400", async () => {
    const rightToken = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${rightToken}`)
      .send({ state: "already-used-token" })
      .expect(400);
  });

  it("confirm: a missing state body 400s before reaching the service (DTO validation)", async () => {
    const rightToken = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${rightToken}`)
      .send({})
      .expect(400);

    expect(mailboxConnection.confirmConnect).not.toHaveBeenCalled();
  });
});
