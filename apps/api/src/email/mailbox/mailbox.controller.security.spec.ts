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
import { listenOnLoopback } from "../../common/testing/listen-loopback";

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
    startConnectMicrosoft: jest.Mock;
    previewConnect: jest.Mock;
    confirmConnect: jest.Mock;
    discardPendingGrant: jest.Mock;
    disconnect: jest.Mock;
  };
  const SECRET_HEADER = "X-Mailbox-Connect-Secret";
  const PREVIEW = "/settings/email/mailbox/confirm/pending-grant-token/preview";
  const CANCEL = "/settings/email/mailbox/confirm/cancel";

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
      startConnect: jest.fn().mockResolvedValue({
        url: "https://accounts.google.com/o/oauth2/v2/auth?mock=1",
        connectSecret: "g-secret",
      }),
      startConnectMicrosoft: jest.fn().mockResolvedValue({
        url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?mock=1",
        connectSecret: "ms-secret",
      }),
      // Simulate the REAL holder rule (tested for real in mailbox.controller.connect-binding
      // .spec.ts and the service specs): proves the controller passes the CALLER's own JWT
      // identity and the header's connect secret through, not a hardcoded/omitted one.
      previewConnect: jest.fn(
        async (token: string, secret: unknown, userId: string, tenantId: string) => {
          if (userId !== "admin-1" || tenantId !== "tenant-a") {
            throw new ForbiddenException("mailbox_confirm_identity_mismatch");
          }
          if (secret !== "tab-secret")
            throw new ForbiddenException("mailbox_connect_secret_mismatch");
          return { provider: "GOOGLE", accountEmail: "owner@acme.test" };
        },
      ),
      confirmConnect: jest.fn(
        async (state: string, secret: unknown, userId: string, tenantId: string) => {
          if (state === "already-used-token") throw new BadRequestException("state_invalid");
          if (userId !== "admin-1" || tenantId !== "tenant-a") {
            throw new ForbiddenException("mailbox_confirm_identity_mismatch");
          }
          if (secret !== "tab-secret")
            throw new ForbiddenException("mailbox_connect_secret_mismatch");
          return { configured: true, connected: true, accountEmail: "owner@acme.test" };
        },
      ),
      discardPendingGrant: jest.fn().mockResolvedValue(undefined),
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
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => jest.clearAllMocks());

  // ── unauthenticated ────────────────────────────────────────────────────────

  it("no Authorization header: every guarded route 401s", async () => {
    await request(app.getHttpServer()).get("/settings/email/mailbox").expect(401);
    await request(app.getHttpServer()).get("/settings/email/mailbox/google/start").expect(401);
    await request(app.getHttpServer()).get("/settings/email/mailbox/microsoft/start").expect(401);
    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .send({ state: "x" })
      .expect(401);
    await request(app.getHttpServer()).get(PREVIEW).set(SECRET_HEADER, "tab-secret").expect(401);
    await request(app.getHttpServer()).post(CANCEL).send({ state: "x" }).expect(401);
    await request(app.getHttpServer()).delete("/settings/email/mailbox").expect(401);
    expect(mailboxConnection.previewConnect).not.toHaveBeenCalled();
    expect(mailboxConnection.discardPendingGrant).not.toHaveBeenCalled();
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
      .get("/settings/email/mailbox/microsoft/start")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ state: "x" })
      .expect(403);
    await request(app.getHttpServer())
      .get(PREVIEW)
      .set("Authorization", `Bearer ${token}`)
      .set(SECRET_HEADER, "tab-secret")
      .expect(403);
    await request(app.getHttpServer())
      .post(CANCEL)
      .set("Authorization", `Bearer ${token}`)
      .send({ state: "x" })
      .expect(403);
    await request(app.getHttpServer())
      .delete("/settings/email/mailbox")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);

    expect(mailboxConnection.confirmConnect).not.toHaveBeenCalled();
    expect(mailboxConnection.previewConnect).not.toHaveBeenCalled();
    expect(mailboxConnection.discardPendingGrant).not.toHaveBeenCalled();
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
      .get("/settings/email/mailbox/microsoft/start")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(PREVIEW)
      .set("Authorization", `Bearer ${token}`)
      .set(SECRET_HEADER, "tab-secret")
      .expect(200);
    await request(app.getHttpServer())
      .post(CANCEL)
      .set("Authorization", `Bearer ${token}`)
      .send({ state: "pending-grant-token" })
      .expect(204);
    await request(app.getHttpServer())
      .delete("/settings/email/mailbox")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
  });

  // ── #2115: /start hands the tab its connect secret; preview/confirm take it from the header ──

  it("start returns the provider URL AND the tab's connect secret", async () => {
    const token = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    const google = await request(app.getHttpServer())
      .get("/settings/email/mailbox/google/start")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    const microsoft = await request(app.getHttpServer())
      .get("/settings/email/mailbox/microsoft/start")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(google.body).toEqual({
      url: "https://accounts.google.com/o/oauth2/v2/auth?mock=1",
      connectSecret: "g-secret",
    });
    expect(microsoft.body).toEqual({
      url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?mock=1",
      connectSecret: "ms-secret",
    });
  });

  it("preview and confirm take the connect secret ONLY from its header: a secret in the query string or the body never reaches the service", async () => {
    const token = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    await request(app.getHttpServer())
      .get(`${PREVIEW}?connectSecret=tab-secret`)
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${token}`)
      .send({ state: "pending-grant-token", connectSecret: "tab-secret" })
      .expect(403);

    expect(mailboxConnection.previewConnect).toHaveBeenCalledWith(
      "pending-grant-token",
      undefined,
      "admin-1",
      "tenant-a",
    );
    expect(mailboxConnection.confirmConnect).toHaveBeenCalledWith(
      "pending-grant-token",
      undefined,
      "admin-1",
      "tenant-a",
    );
  });

  it("preview passes the caller's own JWT identity and the header's secret through", async () => {
    const otherAdminToken = signToken({
      sub: "admin-2",
      role: "TENANT_ADMIN",
      tenantId: "tenant-a",
    });

    await request(app.getHttpServer())
      .get(PREVIEW)
      .set("Authorization", `Bearer ${otherAdminToken}`)
      .set(SECRET_HEADER, "tab-secret")
      .expect(403);

    expect(mailboxConnection.previewConnect).toHaveBeenCalledWith(
      "pending-grant-token",
      "tab-secret",
      "admin-2",
      "tenant-a",
    );
  });

  it("cancel hands the service the token from the body, and 400s on a missing state before reaching it", async () => {
    const token = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    await request(app.getHttpServer())
      .post(CANCEL)
      .set("Authorization", `Bearer ${token}`)
      .send({ state: "pending-grant-token" })
      .expect(204);
    await request(app.getHttpServer())
      .post(CANCEL)
      .set("Authorization", `Bearer ${token}`)
      .send({})
      .expect(400);

    expect(mailboxConnection.discardPendingGrant).toHaveBeenCalledTimes(1);
    expect(mailboxConnection.discardPendingGrant).toHaveBeenCalledWith("pending-grant-token");
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
      .set(SECRET_HEADER, "tab-secret")
      .send({ state: "pending-grant-token" })
      .expect(403);

    expect(mailboxConnection.confirmConnect).toHaveBeenCalledWith(
      "pending-grant-token",
      "tab-secret",
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
      .set(SECRET_HEADER, "tab-secret")
      .send({ state: "pending-grant-token" })
      .expect(403);

    expect(mailboxConnection.confirmConnect).toHaveBeenCalledWith(
      "pending-grant-token",
      "tab-secret",
      "admin-1",
      "tenant-b",
    );
  });

  it("confirm: the matching TENANT_ADMIN with the tab's connect secret succeeds", async () => {
    const rightToken = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    const res = await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${rightToken}`)
      .set(SECRET_HEADER, "tab-secret")
      .send({ state: "pending-grant-token" })
      .expect(200);

    expect(res.body).toMatchObject({ connected: true, accountEmail: "owner@acme.test" });
  });

  it("confirm: the matching TENANT_ADMIN WITHOUT the secret (another tab or browser) gets 403", async () => {
    const rightToken = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${rightToken}`)
      .send({ state: "pending-grant-token" })
      .expect(403);
  });

  it("confirm: a replayed/already-consumed state gets 400", async () => {
    const rightToken = signToken({ sub: "admin-1", role: "TENANT_ADMIN", tenantId: "tenant-a" });

    await request(app.getHttpServer())
      .post("/settings/email/mailbox/confirm")
      .set("Authorization", `Bearer ${rightToken}`)
      .set(SECRET_HEADER, "tab-secret")
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
