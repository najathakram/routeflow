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
    expect(result.modes).toEqual({ ...modes, fulfilment_model: "unset", counter_sales: "unset" });
    expect(policies.effectiveForClient).toHaveBeenCalledWith("t1");
  });
});

// Business profiles 1A (SA-649 R1/R3): `capabilities.fulfilment` is the ONE derived answer. The
// fleet flag comes from the MODULES only; no mode turns fleet on or off. The full mode x
// counter_sales x fleet table is pinned on the helper (fulfilment-capability.spec.ts); this block
// pins the controller wiring and "unset = today".
describe("TenantsController.getMyFeatures: fulfilment modes + capabilities.fulfilment", () => {
  function build(opts: {
    mode?: string;
    counterSales?: string;
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
    const featureConfig = {
      getEffectiveMode: jest
        .fn()
        .mockImplementation((_t: string, key: string) =>
          Promise.resolve(
            key === "fulfilment_model" ? (opts.mode ?? "unset") : (opts.counterSales ?? "unset"),
          ),
        ),
    } as any;
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

  it("UNSET (every existing tenant): today's answer plus the new mode keys and capability", async () => {
    const { controller } = build({ policyModes: { "orders.x": "amend" } });
    const r = await controller.getMyFeatures(caller);
    expect(r.modes).toEqual({
      "orders.x": "amend",
      fulfilment_model: "unset",
      counter_sales: "unset",
    });
    expect(r.served).toEqual(["flag.x"]);
    expect(r.capabilities.fulfilment).toEqual({
      methods: ["ROUTE", "SHIP"],
      staffDefault: "ROUTE",
      staffOpensAs: "order",
      portalMethods: [],
      portalDefault: null,
      counter: "off",
      fleet: false,
      consistent: true,
    });
  });

  it("fleet is true for EITHER module, via addon row or a GRANT override, and a DENY wins", async () => {
    const fleet = async (o: Parameters<typeof build>[0]) =>
      (await build(o).controller.getMyFeatures(caller)).capabilities.fulfilment;
    expect((await fleet({ addons: ["recurring_routes"] })).fleet).toBe(true);
    expect((await fleet({ overrides: new Map([["order_delivery", "GRANT"]]) })).fleet).toBe(true);
    const denied = await fleet({
      mode: "both",
      addons: ["recurring_routes", "order_delivery"],
      overrides: new Map([
        ["recurring_routes", "DENY"],
        ["order_delivery", "DENY"],
      ]),
    });
    expect(denied.fleet).toBe(false);
    expect(denied.consistent).toBe(false);
  });

  it("a hand-set delivery with no fleet module reports fleet:false, consistent:false (R1)", async () => {
    const r = await build({ mode: "delivery" }).controller.getMyFeatures(caller);
    expect(r.capabilities.fulfilment.fleet).toBe(false);
    expect(r.capabilities.fulfilment.consistent).toBe(false);
  });

  it("pickup_ship + counter_sales on: counter is always (in-store beats optional)", async () => {
    const r = await build({ mode: "pickup_ship", counterSales: "on" }).controller.getMyFeatures(
      caller,
    );
    expect(r.capabilities.fulfilment.counter).toBe("always");
    expect(r.capabilities.fulfilment.methods).toEqual(["PICKUP", "SHIP"]);
  });

  it("reads ONLY the caller's tenant (cross-tenant)", async () => {
    const { controller, featureConfig, addonService } = build({});
    await controller.getMyFeatures({ tenantId: "t9" } as unknown as JwtPayload);
    expect(featureConfig.getEffectiveMode).toHaveBeenCalledWith("t9", "fulfilment_model");
    expect(featureConfig.getEffectiveMode).toHaveBeenCalledWith("t9", "counter_sales");
    expect(addonService.getActiveAddons).toHaveBeenCalledWith("t9");
  });

  it("a mode-read failure falls back to unset (today), never a 5xx", async () => {
    const { controller, featureConfig } = build({});
    featureConfig.getEffectiveMode.mockRejectedValue(new Error("db blip"));
    const r = await controller.getMyFeatures(caller);
    expect(r.modes.fulfilment_model).toBe("unset");
    expect(r.capabilities.fulfilment.staffDefault).toBe("ROUTE");
  });

  it("a failed held-addons read is the existing 503 FEATURES_UNAVAILABLE, never a bare 500", async () => {
    const { controller, addonService } = build({});
    addonService.getActiveAddons.mockRejectedValue(new Error("db blip"));
    await expect(controller.getMyFeatures(caller)).rejects.toMatchObject({
      status: 503,
      response: expect.objectContaining({ code: "FEATURES_UNAVAILABLE" }),
    });
  });
});
