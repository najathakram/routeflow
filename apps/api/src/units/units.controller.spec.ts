import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { REQUIRE_PLAN_FLAG_KEY } from "../billing/require-plan-flag.decorator";
import { FEATURE_REGISTRY } from "../billing/feature-registry";
import { PlanFlagGuard } from "../billing/plan-flag.guard";
import { UnitsController } from "./units.controller";

// The denial body is the repo's standard PLAN_GATE 403 (plan-flag-denial.ts, own specs); here we
// only need to know the guard refused.
jest.mock("../billing/plan-flag-denial", () => ({
  buildPlanFlagDenial: jest.fn(async () => new (require("@nestjs/common").ForbiddenException)()),
}));

const proto = UnitsController.prototype as unknown as Record<string, object>;
const handlers = () => Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
const methodOf = (h: string) => Reflect.getMetadata(METHOD_METADATA, proto[h]) as RequestMethod;
const rolesOf = (h: string) => Reflect.getMetadata(ROLES_KEY, proto[h]) as UserRole[] | undefined;

describe("UnitsController", () => {
  it("is mounted at /units behind JwtAuthGuard AND RolesGuard", () => {
    expect(Reflect.getMetadata(PATH_METADATA, UnitsController)).toBe("units");
    const guards = (Reflect.getMetadata("__guards__", UnitsController) ?? []).map(
      (g: { name: string }) => g.name,
    );
    expect(guards).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]));
  });

  it("serves exactly GET, POST and PATCH, and has NO DELETE route (archive, never delete)", () => {
    const methods = handlers().map(methodOf);
    expect(methods.sort()).toEqual(
      [RequestMethod.GET, RequestMethod.PATCH, RequestMethod.POST].sort(),
    );
    expect(methods).not.toContain(RequestMethod.DELETE);
  });

  it("every handler is OPERATOR (covers TENANT_ADMIN), none is unguarded", () => {
    expect(handlers()).toHaveLength(3);
    for (const h of handlers()) expect(rolesOf(h)).toEqual([UserRole.OPERATOR]);
  });

  it("every route needs flag.units_settings_v1 (owner-granted per tenant once the backfill ran)", () => {
    const guards = (Reflect.getMetadata("__guards__", UnitsController) ?? []).map(
      (g: { name: string }) => g.name,
    );
    expect(guards).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard", "PlanFlagGuard"]));
    // Class-level: a handler added later is gated too.
    expect(Reflect.getMetadata(REQUIRE_PLAN_FLAG_KEY, UnitsController)).toBe(
      "flag.units_settings_v1",
    );
    for (const h of handlers()) {
      const keys = Reflect.getMetadataKeys(proto[h]).map(String);
      expect(keys.filter((k) => /addon/i.test(k))).toEqual([]);
    }
  });

  it("the feature registry lists the units routes under the same flag, ENFORCED and never default-granted", () => {
    const row = FEATURE_REGISTRY.find((r) => r.key === "flag.units_settings_v1");
    expect(row?.gate.via).toBe("RequirePlanFlag");
    expect(row?.gate.state).toBe("enforced");
    expect(row?.gate.routes.some((r) => /^ALL \/units\b/.test(r))).toBe(true);
    expect(row?.defaultGranted).toBe(false);
  });

  it("flag.units_v1 keeps ONLY the product ladder routes (Settings > Units moved to its own flag)", () => {
    const row = FEATURE_REGISTRY.find((r) => r.key === "flag.units_v1");
    expect(row?.gate.routes.join(" ")).toContain("/products/:productId/units");
    expect(row?.gate.routes.some((r) => /^ALL \/units\b/.test(r))).toBe(false);
  });

  describe("PlanFlagGuard against every /units route (the write routes included)", () => {
    const guardFor = (granted: string[]) =>
      new PlanFlagGuard(
        new Reflector(),
        {} as never,
        {} as never,
        {} as never,
        { can: async (_t: string, key: string) => granted.includes(key) } as never,
      );
    const ctx = (h: string) =>
      ({
        getHandler: () => proto[h],
        getClass: () => UnitsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { tenantId: "t1" } }) }),
      }) as never;

    it.each(["list", "create", "update"])(
      "%s: refused with only flag.units_v1 (a live units_v1 tenant is NOT auto-granted)",
      async (h) => {
        await expect(guardFor(["flag.units_v1"]).canActivate(ctx(h))).rejects.toThrow();
      },
    );
    it.each(["list", "create", "update"])(
      "%s: allowed once flag.units_settings_v1 is granted",
      async (h) => {
        await expect(guardFor(["flag.units_settings_v1"]).canActivate(ctx(h))).resolves.toBe(true);
      },
    );
  });

  describe("RolesGuard against the handlers", () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (h: string, role: UserRole) =>
      ({
        getHandler: () => proto[h],
        getClass: () => UnitsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as never;

    it.each(["list", "create", "update"])(
      "%s: operator and tenant admin pass; driver and buyer are refused",
      (h) => {
        expect(guard.canActivate(ctx(h, UserRole.OPERATOR))).toBe(true);
        expect(guard.canActivate(ctx(h, UserRole.TENANT_ADMIN))).toBe(true);
        expect(guard.canActivate(ctx(h, UserRole.DRIVER))).toBe(false);
        expect(guard.canActivate(ctx(h, UserRole.CUSTOMER))).toBe(false);
      },
    );
  });

  it("GET /units is the active array; ?archived=1 is one archived page with the cursor passed through (SA-810)", async () => {
    const units = {
      list: jest.fn().mockResolvedValue([]),
      listArchived: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const c = new UnitsController(units as never);
    await c.list();
    expect(units.list).toHaveBeenCalledWith();
    await c.list("1", "abc");
    expect(units.listArchived).toHaveBeenCalledWith("abc");
    await c.list("true", "");
    expect(units.listArchived).toHaveBeenLastCalledWith(undefined);
    expect(units.list).toHaveBeenCalledTimes(1);
  });
});
