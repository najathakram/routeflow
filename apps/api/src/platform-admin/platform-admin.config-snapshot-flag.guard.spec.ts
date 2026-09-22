/**
 * The config-snapshot flag endpoints through the REAL guard chain (A2c lows on #1059). The controller spec
 * calls the methods directly, so it can never see a 403; here the real `SuperAdminGuard` runs (only the JWT
 * strategy is faked, to place a role on the request), with the real `ValidationPipe` rules, over HTTP.
 * A non-admin must be refused BEFORE the flag service is touched.
 */
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import request from "supertest";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { PlatformAdminController } from "./platform-admin.controller";
import { ConfigSnapshotFlagService } from "../billing/config-snapshot-flag.service";

describe("PUT/GET platform-admin/entitlements/config-snapshot: the real SuperAdminGuard", () => {
  let app: INestApplication;
  const flag = {
    isEnabled: jest.fn().mockResolvedValue(false),
    setEnabledAudited: jest.fn().mockResolvedValue(undefined),
    setEnabled: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    // every other constructor dependency is irrelevant to these routes: an empty stand-in each
    const paramTypes: unknown[] = Reflect.getMetadata("design:paramtypes", PlatformAdminController);
    const moduleRef = await Test.createTestingModule({
      controllers: [PlatformAdminController],
      providers: paramTypes.map((t) =>
        t === ConfigSnapshotFlagService
          ? { provide: t as never, useValue: flag }
          : { provide: t as never, useValue: {} },
      ),
    })
      // the JWT strategy is the only fake: it puts the requested role on the request. SuperAdminGuard is REAL.
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          const role = req.headers["x-test-role"];
          if (role) req.user = { sub: "u-1", role };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });
  afterAll(async () => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("the class-level guards are JwtAuthGuard then the REAL SuperAdminGuard (no handler opts out)", () => {
    expect(Reflect.getMetadata("__guards__", PlatformAdminController)).toEqual([
      JwtAuthGuard,
      SuperAdminGuard,
    ]);
    for (const h of ["getConfigSnapshotFlag", "setConfigSnapshotFlag"] as const) {
      expect(
        Reflect.getMetadata("__guards__", PlatformAdminController.prototype[h]),
      ).toBeUndefined();
    }
  });

  it.each([UserRole.CUSTOMER, UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.DRIVER])(
    "a %s is refused with 403 on BOTH routes and the flag service is never touched",
    async (role) => {
      await request(app.getHttpServer())
        .put("/platform-admin/entitlements/config-snapshot")
        .set("x-test-role", role)
        .send({ enabled: true, reason: "not allowed" })
        .expect(403);
      await request(app.getHttpServer())
        .get("/platform-admin/entitlements/config-snapshot")
        .set("x-test-role", role)
        .expect(403);
      expect(flag.setEnabledAudited).not.toHaveBeenCalled();
      expect(flag.setEnabled).not.toHaveBeenCalled();
      expect(flag.isEnabled).not.toHaveBeenCalled();
    },
  );

  it("an unauthenticated request (no user on it) is refused with 403", async () => {
    await request(app.getHttpServer())
      .put("/platform-admin/entitlements/config-snapshot")
      .send({ enabled: true, reason: "anon" })
      .expect(403);
    expect(flag.setEnabledAudited).not.toHaveBeenCalled();
  });

  it("a SUPER_ADMIN switches it: 200, through setEnabledAudited with THEIR id and the reason", async () => {
    const res = await request(app.getHttpServer())
      .put("/platform-admin/entitlements/config-snapshot")
      .set("x-test-role", UserRole.SUPER_ADMIN)
      .send({ enabled: true, reason: "pilot on the test tenant" })
      .expect(200);
    expect(res.body).toEqual({ enabled: true });
    expect(flag.setEnabledAudited).toHaveBeenCalledWith(true, {
      userId: "u-1",
      reason: "pilot on the test tenant",
    });
  });

  it("a SUPER_ADMIN GET reads the current state", async () => {
    flag.isEnabled.mockResolvedValueOnce(true);
    const res = await request(app.getHttpServer())
      .get("/platform-admin/entitlements/config-snapshot")
      .set("x-test-role", UserRole.SUPER_ADMIN)
      .expect(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it("the real pipe still refuses a bad body from a SUPER_ADMIN: the STRING 'false' and a blank reason are 400s", async () => {
    for (const body of [
      { enabled: "false", reason: "pilot" },
      { enabled: true, reason: "   " },
      { enabled: true, reason: "pilot", force: true },
    ]) {
      await request(app.getHttpServer())
        .put("/platform-admin/entitlements/config-snapshot")
        .set("x-test-role", UserRole.SUPER_ADMIN)
        .send(body)
        .expect(400);
    }
    expect(flag.setEnabledAudited).not.toHaveBeenCalled();
  });
});
