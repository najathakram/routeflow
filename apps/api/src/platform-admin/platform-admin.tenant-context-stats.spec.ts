import "reflect-metadata";
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PlatformAdminController } from "./platform-admin.controller";
import { PlatformAdminService } from "./platform-admin.service";
import { SuperAdminGuard } from "../tenant/super-admin.guard";

/**
 * SA-619 PR-2a: GET /platform-admin/tenant-context/stats: counts only (no data, no stack), SUPER_ADMIN
 * only. The class-level SuperAdminGuard is what makes it 403 for everyone else.
 */
describe("GET /platform-admin/tenant-context/stats (SA-619 PR-2a)", () => {
  it("is a GET route at tenant-context/stats on the platform-admin controller", () => {
    const handler = (PlatformAdminController.prototype as any).tenantContextStats;
    expect(typeof handler).toBe("function");
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("tenant-context/stats");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, PlatformAdminController)).toBe("platform-admin");
  });

  it("sits behind the class-level SuperAdminGuard: a non-admin is 403, a SUPER_ADMIN passes", () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, PlatformAdminController) ?? [];
    expect(guards).toContain(SuperAdminGuard);
    const guard = new SuperAdminGuard();
    const ctx = (role: UserRole) =>
      ({ switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }) }) as any;
    for (const role of [
      UserRole.OPERATOR,
      UserRole.TENANT_ADMIN,
      UserRole.DRIVER,
      UserRole.CUSTOMER,
    ])
      expect(guard.canActivate(ctx(role))).toBe(false);
    expect(guard.canActivate(ctx(UserRole.SUPER_ADMIN))).toBe(true);
  });

  it("the controller delegates to the service, and the service returns the PrismaService stats unchanged", () => {
    const stats = { enforce: false, since: "t", counts: { MISSING: 1, SUPER_ADMIN_CREATE: 0 } };
    const svc = Object.create(PlatformAdminService.prototype);
    svc.prisma = { tenantContextStats: jest.fn().mockReturnValue(stats) };
    expect(svc.tenantContextStats()).toBe(stats);
    const ctl = Object.create(PlatformAdminController.prototype);
    ctl.svc = { tenantContextStats: jest.fn().mockReturnValue(stats) };
    expect(ctl.tenantContextStats()).toBe(stats);
  });
});
