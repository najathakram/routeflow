import "reflect-metadata";
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { AuditService } from "../audit/audit.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { listenOnLoopback } from "../common/testing/listen-loopback";
import { AppleOAuthService } from "./apple-oauth.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { GoogleOAuthService } from "./google-oauth.service";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { StaffHandoffService } from "./handoff/staff-handoff.service";
import { UsersController } from "../users/users.controller";
import { UsersService } from "../users/users.service";
import { OperatorPermissionsService } from "./permissions/operator-permissions.service";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require("supertest");

/**
 * SA-778: the account routes (own credentials, linked identities) in a support session. The real
 * NoImpersonationGuard runs over the real controller metadata; only the JWT strategy is replaced by a
 * stand-in that stamps `request.user` from headers. A refused request must write no password, mint no
 * session and link no identity.
 */

const MESSAGE = "This action isn't available in a support session. Ask the account admin to do it.";

const ACCOUNT_ROUTES: Array<[string, "get" | "post", string, object]> = [
  ["change-password", "post", "/auth/change-password", { currentPassword: "x", newPassword: "y" }],
  ["set-password", "post", "/auth/set-password", { newPassword: "Passw0rd!long" }],
  ["google link", "get", "/auth/google/link", {}],
  ["apple link", "post", "/auth/apple/link", { identityToken: "x", nonce: "y" }],
  ["admin reset-password", "post", "/users/u-other/reset-password", {}],
];

describe("account routes in a support session (SA-778)", () => {
  let app: INestApplication;
  const auth = {
    changePassword: jest.fn(),
    setPassword: jest.fn(),
    listSessions: jest.fn(),
  };
  const google = { isConfigured: jest.fn(), generateLinkUrl: jest.fn() };
  const apple = { isConfigured: jest.fn(), linkAppleAccount: jest.fn() };
  const users = { resetPassword: jest.fn() };
  const audit = { log: jest.fn() };
  const allMocks = [
    users.resetPassword,
    ...Object.values(auth),
    google.generateLinkUrl,
    apple.linkAppleAccount,
    google.isConfigured,
    apple.isConfigured,
  ];

  const fakeJwt: CanActivate = {
    canActivate(ctx: ExecutionContext) {
      const req = ctx.switchToHttp().getRequest();
      const role = req.headers["x-role"];
      if (!role) throw new UnauthorizedException();
      req.user = {
        id: "u-admin",
        sub: "u-admin",
        role,
        tenantId: "t-1",
        impersonatedBy: req.headers["x-impersonated-by"] || undefined,
      };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, UsersController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: ConfigService, useValue: { get: () => undefined } },
        { provide: GoogleOAuthService, useValue: google },
        { provide: AppleOAuthService, useValue: apple },
        { provide: StaffHandoffService, useValue: {} },
        { provide: UsersService, useValue: users },
        { provide: OperatorPermissionsService, useValue: {} },
        { provide: AuditService, useValue: audit },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(fakeJwt)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    for (const m of [...allMocks, audit.log]) m.mockReset();
    audit.log.mockResolvedValue(undefined);
    auth.changePassword.mockResolvedValue({ ok: true });
    auth.setPassword.mockResolvedValue({ accessToken: "a", refreshToken: "r" });
    auth.listSessions.mockResolvedValue([]);
    users.resetPassword.mockResolvedValue({ tempPassword: "TEMP-1234" });
    google.isConfigured.mockReturnValue(true);
    google.generateLinkUrl.mockResolvedValue("https://accounts.example/consent");
    apple.isConfigured.mockReturnValue(true);
    apple.linkAppleAccount.mockResolvedValue(undefined);
  });

  const call = (verb: "get" | "post", path: string, role?: string, supportSession = false) => {
    const req = request(app.getHttpServer())[verb](path);
    if (role) req.set("x-role", role);
    if (supportSession) req.set("x-impersonated-by", "sa-1");
    return req;
  };

  it.each(ACCOUNT_ROUTES)(
    "a support session on %s is refused 403 with the coded body; nothing is written, minted or linked; one audit row",
    async (_name, verb, path, body) => {
      const res = await call(verb, path, "TENANT_ADMIN", true).send(body);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(API_ERROR_CODES.IMPERSONATION_NOT_ALLOWED);
      expect(res.body.message).toBe(MESSAGE);
      for (const m of allMocks) expect(m).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledTimes(1);
      expect(audit.log.mock.calls[0][0]).toMatchObject({
        action: "impersonation.action-refused",
        entityType: "account",
        tenantId: "t-1",
        impersonatedBy: "sa-1",
        meta: { superAdminId: "sa-1", tenantId: "t-1", route: expect.any(String) },
      });
    },
  );

  it.each(ACCOUNT_ROUTES)(
    "a real user on %s is unchanged: the handler runs, no audit row",
    async (_name, verb, path, body) => {
      const res = await call(verb, path, "TENANT_ADMIN").send(body);

      expect(res.status).toBeLessThan(300);
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it("a support session never receives a temporary password from the admin reset", async () => {
    const res = await call("post", "/users/u-other/reset-password", "TENANT_ADMIN", true).send({});
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain("TEMP-1234");
    expect(users.resetPassword).not.toHaveBeenCalled();
  });

  it("no token: 401, nothing audited, nothing run", async () => {
    await call("post", "/auth/set-password").send({ newPassword: "Passw0rd!long" }).expect(401);
    expect(audit.log).not.toHaveBeenCalled();
    expect(auth.setPassword).not.toHaveBeenCalled();
  });

  it("a support session can still list the account's sessions (a read)", async () => {
    const res = await call("get", "/auth/sessions", "TENANT_ADMIN", true);
    expect(res.status).toBe(200);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
