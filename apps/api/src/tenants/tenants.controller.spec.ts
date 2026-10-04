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
      {} as any, // policies (SA-138) — unused by getMyAddons
      {} as any, // featureConfig (business profiles) — unused by getMyAddons
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

describe("TenantsController.getMyFeatures — SA-138 policy modes carrier", () => {
  function build(policyModes: Record<string, string>) {
    const authority = {
      resolveAll: jest.fn().mockResolvedValue({
        tenantId: "t1",
        planKey: "TEAM",
        catalogVersionId: "cv1",
        byKey: new Map(),
        computedAt: "2026-09-24T00:00:00.000Z",
      }),
      servedFlags: jest.fn().mockResolvedValue([]),
    } as any;
    const policies = { effectiveForClient: jest.fn().mockResolvedValue(policyModes) } as any;
    const controller = new TenantsController(
      {} as any,
      {} as any,
      { getActiveAddons: jest.fn().mockResolvedValue([]) } as any,
      { allActive: jest.fn().mockResolvedValue(new Map()) } as any,
      authority,
      policies,
      { getEffectiveMode: jest.fn().mockResolvedValue("unset") } as any,
    );
    return { controller, policies };
  }

  it("serves the tenant-scope effective policy values in `modes`, for this tenant only", async () => {
    const modes = {
      "orders.driverAtDoorEdit": "amend",
      "invoicing.priceDisclosure": '["originalPrice","discount","msrp"]',
    };
    const { controller, policies } = build(modes);
    const result = await controller.getMyFeatures({ tenantId: "t1" } as unknown as JwtPayload);
    // Business profiles 1A: today's answer plus exactly the one new key (unset = today).
    expect(result.modes).toEqual({ ...modes, fulfilment_model: "unset" });
    expect(policies.effectiveForClient).toHaveBeenCalledWith("t1");
  });
});

// Business profiles 1A (SA-649 R1): `capability.fleet` comes from the MODULES only (the same
// effective addon resolution /tenants/me/addons uses); the fulfilment mode never turns fleet on or
// off, and a delivery/both mode with no fleet module reports consistent:false.
describe("TenantsController.getMyFeatures — fulfilment_model + capability (R1)", () => {
  function build(opts: {
    mode: string;
    addons?: string[];
    overrides?: Map<string, "GRANT" | "DENY">;
    policyModes?: Record<string, string>;
  }) {
    const authority = {
      resolveAll: jest.fn().mockResolvedValue({
        tenantId: "t1",
        planKey: "TEAM",
        catalogVersionId: "cv1",
        byKey: new Map(),
        computedAt: "2026-10-04T00:00:00.000Z",
      }),
      servedFlags: jest.fn().mockResolvedValue(["flag.x"]),
    } as any;
    const policies = {
      effectiveForClient: jest.fn().mockResolvedValue(opts.policyModes ?? {}),
    } as any;
    const addonService = { getActiveAddons: jest.fn().mockResolvedValue(opts.addons ?? []) } as any;
    const featureOverrides = {
      allActive: jest.fn().mockResolvedValue(opts.overrides ?? new Map()),
    } as any;
    const featureConfig = { getEffectiveMode: jest.fn().mockResolvedValue(opts.mode) } as any;
    const controller = new TenantsController(
      {} as any,
      {} as any,
      addonService,
      featureOverrides,
      authority,
      policies,
      featureConfig,
    );
    return { controller, featureConfig, addonService };
  }
  const caller = { tenantId: "t1" } as unknown as JwtPayload;

  it("UNSET (every existing tenant): the answer is today's plus the new mode key and capability", async () => {
    const { controller } = build({ mode: "unset", policyModes: { "orders.x": "amend" } });
    const r = await controller.getMyFeatures(caller);
    expect(r.modes).toEqual({ "orders.x": "amend", fulfilment_model: "unset" });
    expect(r.served).toEqual(["flag.x"]);
    expect(r.capability).toEqual({
      fleet: false,
      fulfilment: null,
      consistent: true,
      inconsistentModes: [],
    });
  });

  it.each([
    // [mode, fleet module held?, expected fleet, fulfilment, consistent]
    ["unset", false, false, null, true],
    ["unset", true, true, null, true],
    ["ship", false, false, "ship", true],
    ["ship", true, true, "ship", true],
    ["delivery", false, false, "delivery", false],
    ["delivery", true, true, "delivery", true],
    ["both", false, false, "both", false],
    ["both", true, true, "both", true],
  ] as const)(
    "mode %s with fleet module held=%s -> fleet %s, fulfilment %s, consistent %s",
    async (mode, held, fleet, fulfilment, consistent) => {
      const { controller } = build({ mode, addons: held ? ["order_delivery"] : [] });
      const r = await controller.getMyFeatures(caller);
      expect(r.capability.fleet).toBe(fleet);
      expect(r.capability.fulfilment).toBe(fulfilment);
      expect(r.capability.consistent).toBe(consistent);
      expect(r.capability.inconsistentModes).toEqual(consistent ? [] : ["fulfilment_model"]);
    },
  );

  it("fleet is true for EITHER module, via addon row or a GRANT override, and a DENY wins", async () => {
    expect(
      (
        await build({ mode: "unset", addons: ["recurring_routes"] }).controller.getMyFeatures(
          caller,
        )
      ).capability.fleet,
    ).toBe(true);
    expect(
      (
        await build({
          mode: "unset",
          overrides: new Map([["order_delivery", "GRANT"]]),
        }).controller.getMyFeatures(caller)
      ).capability.fleet,
    ).toBe(true);
    expect(
      (
        await build({
          mode: "both",
          addons: ["recurring_routes", "order_delivery"],
          overrides: new Map([
            ["recurring_routes", "DENY"],
            ["order_delivery", "DENY"],
          ]),
        }).controller.getMyFeatures(caller)
      ).capability,
    ).toEqual({
      fleet: false,
      fulfilment: "both",
      consistent: false,
      inconsistentModes: ["fulfilment_model"],
    });
  });

  it("reads ONLY the caller's tenant (cross-tenant)", async () => {
    const { controller, featureConfig, addonService } = build({ mode: "unset" });
    await controller.getMyFeatures({ tenantId: "t9" } as unknown as JwtPayload);
    expect(featureConfig.getEffectiveMode).toHaveBeenCalledWith("t9", "fulfilment_model");
    expect(addonService.getActiveAddons).toHaveBeenCalledWith("t9");
  });

  it("a mode-read failure falls back to unset (today), never a 5xx", async () => {
    const { controller, featureConfig } = build({ mode: "unset" });
    featureConfig.getEffectiveMode.mockRejectedValue(new Error("db blip"));
    const r = await controller.getMyFeatures(caller);
    expect(r.modes.fulfilment_model).toBe("unset");
    expect(r.capability.fulfilment).toBeNull();
  });
});
