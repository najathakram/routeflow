/**
 * Security test for the tenants module.
 *
 * developer_mode rollout: GET me/addons was OPERATOR-only. Pure DRIVER-role
 * users of a dev-mode tenant need to read this endpoint (the mobile
 * useDeveloperMode hook runs on driver screens), so the route was widened to
 * OPERATOR + DRIVER. Reflection-only (no DI) — mirrors
 * customers.security.spec.ts's pattern.
 */
import "reflect-metadata";
import { UserRole } from "@prisma/client";
import { TenantsController } from "./tenants.controller";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import type { JwtPayload } from "../auth/jwt-payload.interface";

describe("TenantsController — me/addons role guard", () => {
  it("getMyAddons allows OPERATOR and DRIVER", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, TenantsController.prototype.getMyAddons);
    expect(roles).toEqual([UserRole.OPERATOR, UserRole.DRIVER]);
  });
});

// Feature-grants PR-1 (owner ruling 2026-09-16): /tenants/me/addons folds in active overrides —
// GRANT surfaces a key the tenant holds no addon row for at all; DENY hides one it does hold.
describe("TenantsController.getMyAddons — override merge", () => {
  function build(active: string[], overrides: Map<string, "GRANT" | "DENY">) {
    const addonService = { getActiveAddons: jest.fn().mockResolvedValue(active) } as any;
    const featureOverrides = { allActive: jest.fn().mockResolvedValue(overrides) } as any;
    const controller = new TenantsController(
      {} as any, // tenantsService — unused by getMyAddons
      {} as any, // emailService — unused by getMyAddons
      addonService,
      featureOverrides,
      {} as any, // authority (feature grants v2 brief A) — unused by getMyAddons
    );
    return { controller, addonService, featureOverrides };
  }

  it("returns an empty list without calling any collaborator when there is no tenant (e.g. SUPER_ADMIN)", async () => {
    const { controller, addonService, featureOverrides } = build([], new Map());
    const result = await controller.getMyAddons({ tenantId: null } as unknown as JwtPayload);
    expect(result).toEqual({ addons: [] });
    expect(addonService.getActiveAddons).not.toHaveBeenCalled();
    expect(featureOverrides.allActive).not.toHaveBeenCalled();
  });

  it("no override rows: returns exactly the held addons, byte-identical to today", async () => {
    const { controller } = build(["tobacco_dealer"], new Map());
    const result = await controller.getMyAddons({ tenantId: "t1" } as unknown as JwtPayload);
    expect(result).toEqual({ addons: ["tobacco_dealer"] });
  });

  it("a GRANT override surfaces a key the tenant holds no addon row for", async () => {
    const { controller } = build([], new Map([["recurring_routes", "GRANT"]]));
    const result = await controller.getMyAddons({ tenantId: "t1" } as unknown as JwtPayload);
    expect(result.addons).toEqual(["recurring_routes"]);
  });

  it("a DENY override hides a key the tenant does hold via a real addon row", async () => {
    const { controller } = build(
      ["tobacco_dealer", "recurring_routes"],
      new Map([["tobacco_dealer", "DENY"]]),
    );
    const result = await controller.getMyAddons({ tenantId: "t1" } as unknown as JwtPayload);
    expect(result.addons).toEqual(["recurring_routes"]);
  });

  // Opus review of 8130b204, item 6: only a RequireAddon-gated key belongs in this array — a
  // flag-namespace override has no addon-consumer to reach here.
  it("a GRANT override on a non-RequireAddon key (a flag) is never merged in (gateVia filter)", async () => {
    const { controller } = build([], new Map([["flag.msrp", "GRANT"]]));
    const result = await controller.getMyAddons({ tenantId: "t1" } as unknown as JwtPayload);
    expect(result.addons).toEqual([]);
  });
});
