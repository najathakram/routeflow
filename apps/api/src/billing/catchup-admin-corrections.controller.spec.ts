import "reflect-metadata";
import { ExecutionContext } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { SuperAdminGuard } from "../tenant/super-admin.guard";
import { CatchupAdminController } from "../platform-admin/catchup-admin.controller";

/**
 * SA-1122 (i) C8: the three correction routes sit behind SuperAdminGuard (a TENANT_ADMIN token is refused with 403),
 * and each route reaches the one service.
 */
const ctx = (role: string) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  }) as unknown as ExecutionContext;

describe("CatchupAdminController corrections", () => {
  const proto = CatchupAdminController.prototype as any;
  const route = (name: string) => ({
    path: Reflect.getMetadata(PATH_METADATA, proto[name]),
    method: Reflect.getMetadata(METHOD_METADATA, proto[name]),
  });

  it("C8: the class guards include SuperAdminGuard, which refuses a TENANT_ADMIN and an OPERATOR", () => {
    const guards: unknown[] = Reflect.getMetadata("__guards__", CatchupAdminController) ?? [];
    expect(guards).toContain(SuperAdminGuard);
    const guard = new SuperAdminGuard();
    expect(guard.canActivate(ctx("TENANT_ADMIN"))).toBe(false);
    expect(guard.canActivate(ctx("OPERATOR"))).toBe(false);
    expect(guard.canActivate(ctx("SUPER_ADMIN"))).toBe(true);
  });

  it("the three routes are GET corrections, POST preview, POST apply under tenants/:id/billing", () => {
    expect(route("listCorrections")).toEqual({
      path: "tenants/:id/billing/catchup-corrections",
      method: RequestMethod.GET,
    });
    expect(route("previewCorrection")).toEqual({
      path: "tenants/:id/billing/catchup-corrections/preview",
      method: RequestMethod.POST,
    });
    expect(route("applyCorrection")).toEqual({
      path: "tenants/:id/billing/catchup-corrections",
      method: RequestMethod.POST,
    });
  });

  it("the routes call the one service, and apply passes the signed-in admin as the actor", async () => {
    const corrections = {
      view: jest.fn(async () => "view"),
      preview: jest.fn(async () => "preview"),
      apply: jest.fn(async () => "apply"),
    };
    const c = new CatchupAdminController({} as any, {} as any, corrections as any);
    await c.listCorrections("t1");
    await c.previewCorrection("t1", { voidCoverage: ["m"] } as any);
    await c.applyCorrection("t1", { voidCoverage: ["m"] } as any, { sub: "admin-9" } as any);
    expect(corrections.view).toHaveBeenCalledWith("t1");
    expect(corrections.preview).toHaveBeenCalledWith("t1", { voidCoverage: ["m"] });
    expect(corrections.apply).toHaveBeenCalledWith("t1", { voidCoverage: ["m"] }, "admin-9");
  });
});
