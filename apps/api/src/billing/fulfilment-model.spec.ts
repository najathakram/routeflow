import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AddonService } from "./addon.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";
import { FeatureConfigStore } from "./feature-config.store";
import { FeatureConfigService } from "./feature-config.service";
import { FEATURE_REGISTRY } from "./feature-registry";
import { isFleetHeld } from "./fulfilment-capability";
import { FulfillPath } from "@prisma/client";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateOrderDto } from "../orders/dto/create-order.dto";
import { FULFILMENT_MODE_VALUES, COUNTER_SALES_MODE_VALUES } from "@routeflow/types";

/**
 * Business profiles 1A: `fulfilment_model` is a free configuration row ("how do orders reach
 * your customers?"), shaped like `routes_dispatch`. Unset = today's behaviour exactly.
 */
/** getActiveAddons derived from a hasAddon mock, so a test sets the held keys one way. */
const heldVia = async (hasAddon: jest.Mock, t: string) => {
  const out: string[] = [];
  for (const k of ["recurring_routes", "order_delivery"]) if (await hasAddon(t, k)) out.push(k);
  return out;
};

const row = () => FEATURE_REGISTRY.find((f) => f.key === "fulfilment_model");

describe("fulfilment_model registry row", () => {
  it("is a boolean config row that defaults to unset and changes no entitlement", () => {
    const r = row();
    expect(r).toBeDefined();
    expect(r!.config?.fallbackMode).toBe("unset");
    expect(r!.defaultGranted).toBe(true);
    expect(r!.gate.via).toBe("none");
    expect(r!.billing).toEqual({ skus: [], selfService: false });
  });

  it("offers unset / delivery / ship / both / pickup (In store only) / pickup_ship; the pickup modes are NOT available until the counter-sale work (SA-671 M1)", () => {
    const modes = row()!.config!.modes;
    expect(Object.keys(modes)).toEqual([
      "unset",
      "delivery",
      "ship",
      "both",
      "pickup",
      "pickup_ship",
    ]);
    expect(modes.unset.label).toBe("Not configured (today's behavior)");
    expect(modes.unset.available).toBe(true);
    for (const m of ["delivery", "ship", "both"]) {
      expect(modes[m].available).toBe(true);
      expect(modes[m].lifecycle).toBe("ga");
    }
    // No PICKUP order can be written yet (the enum value is not on master), so a tenant must not
    // be put in a mode whose only method is PICKUP. The counter-sale work flips these back.
    for (const m of ["pickup", "pickup_ship"]) expect(modes[m].available).toBe(false);
    expect(modes.pickup.label).toBe("In store only");
    expect(modes.pickup_ship.label).toBe("In store + shipping");
  });

  it("the shared FULFILMENT_MODE_VALUES list equals the registry's modes (no hand-typed mirror drift)", () => {
    expect([...FULFILMENT_MODE_VALUES]).toEqual(Object.keys(row()!.config!.modes));
  });

  it("the mode schema stays allOf-only (the fleet guard lives in the service, not the schema)", () => {
    for (const m of Object.values(row()!.config!.modes)) {
      expect(Object.keys(m.requires ?? {})).not.toContain("anyOf");
      expect(Object.keys(m)).not.toContain("requiresAnyOf");
    }
  });
});

describe("FeatureConfigService: a hand-set delivery/both mode needs a fleet key", () => {
  let service: FeatureConfigService;
  let upsert: jest.Mock;
  let hasAddon: jest.Mock;
  let getActiveAddons: (t: string) => Promise<string[]>;
  let allActive: jest.Mock;
  let getMode: jest.Mock;

  beforeEach(async () => {
    upsert = jest.fn().mockResolvedValue({});
    hasAddon = jest.fn();
    getActiveAddons = (t: string) => heldVia(hasAddon, t);
    allActive = jest.fn().mockResolvedValue(new Map());
    getMode = jest.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureConfigService,
        {
          provide: PrismaService,
          useValue: {
            tenantFeatureConfig: { upsert, deleteMany: jest.fn() },
            tenant: { findUnique: jest.fn().mockResolvedValue({ id: "t1" }) },
          },
        },
        { provide: FeatureConfigStore, useValue: { getMode, invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        { provide: AddonService, useValue: { hasAddon, getActiveAddons } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn() } },
        {
          provide: FeatureOverrideService,
          useValue: { get: jest.fn().mockResolvedValue(null), allActive },
        },
      ],
    }).compile();
    service = module.get(FeatureConfigService);
  });

  it("delivery with neither fleet key -> 409 FEATURE_MODE_REQUIRES, nothing written", async () => {
    hasAddon.mockResolvedValue(false);
    for (const mode of ["delivery", "both"]) {
      const p = service.set("t1", "fulfilment_model", mode, "r", "admin-1");
      await expect(p).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.set("t1", "fulfilment_model", mode, "r", "admin-1"),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: "FULFILMENT_MODE_NEEDS_FLEET",
          key: "fulfilment_model",
          mode,
          missing: ["recurring_routes", "order_delivery"],
          message: expect.stringMatching(/Routes.*Order delivery/),
        }),
      });
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it("ship is ALLOWED even while both fleet keys are ON (no refusal)", async () => {
    hasAddon.mockResolvedValue(true);
    await service.set("t1", "fulfilment_model", "ship", "r", "admin-1");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("the guard names the code only for fulfilment_model (routes_dispatch keeps FEATURE_MODE_REQUIRES)", async () => {
    hasAddon.mockResolvedValue(false);
    await expect(
      service.set("t1", "routes_dispatch", "scheduled", "r", "admin-1"),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "FEATURE_MODE_REQUIRES" }),
    });
  });

  it("delivery is allowed with ONE fleet key held", async () => {
    hasAddon.mockImplementation((_t: string, k: string) => Promise.resolve(k === "order_delivery"));
    await service.set("t1", "fulfilment_model", "delivery", "r", "admin-1");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("ship needs no fleet key and writes", async () => {
    hasAddon.mockResolvedValue(false);
    await service.set("t1", "fulfilment_model", "ship", "r", "admin-1");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("pickup and pickup_ship are refused as not available yet (SA-671 M1) — nothing is written", async () => {
    hasAddon.mockResolvedValue(false);
    for (const mode of ["pickup", "pickup_ship"]) {
      await expect(service.set("t1", "fulfilment_model", mode, "r", "admin-1")).rejects.toThrow(
        `"${mode}" is not available for "fulfilment_model"`,
      );
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it("an unknown mode is refused", async () => {
    await expect(
      service.set("t1", "fulfilment_model", "martian", "r", "admin-1"),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("FeatureConfigService.getState: delivery/both are BLOCKED without a fleet key", () => {
  const build = async (fleetHeld: boolean) => {
    const module = await Test.createTestingModule({
      providers: [
        FeatureConfigService,
        { provide: PrismaService, useValue: {} },
        {
          provide: FeatureConfigStore,
          useValue: { getMode: jest.fn().mockResolvedValue({ value: "unset", source: "default" }) },
        },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: AddonService,
          useValue: {
            hasAddon: jest.fn().mockResolvedValue(fleetHeld),
            getActiveAddons: jest.fn().mockResolvedValue(fleetHeld ? ["order_delivery"] : []),
          },
        },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn() } },
        {
          provide: FeatureOverrideService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            allActive: jest.fn().mockResolvedValue(new Map()),
          },
        },
      ],
    }).compile();
    return module.get(FeatureConfigService);
  };

  it("no fleet key: delivery and both are blocked; unset, ship, pickup, pickup_ship are allowed", async () => {
    const state = await (await build(false)).getState("t1", "fulfilment_model");
    expect(state.blocked).toEqual(["delivery", "both"]);
    expect(state.allowed).toEqual(["unset", "ship", "pickup", "pickup_ship"]);
  });

  it("a fleet key held: nothing is blocked", async () => {
    const state = await (await build(true)).getState("t1", "fulfilment_model");
    expect(state.blocked).toEqual([]);
  });
});

describe("counter_sales registry row", () => {
  const r = () => FEATURE_REGISTRY.find((f) => f.key === "counter_sales");
  it("is a free config row: unset (today) or on", () => {
    expect(r()).toBeDefined();
    expect(r()!.config?.fallbackMode).toBe("unset");
    expect(Object.keys(r()!.config!.modes)).toEqual(["unset", "on"]);
    expect(r()!.defaultGranted).toBe(true);
    expect(r()!.billing).toEqual({ skus: [], selfService: false });
  });
  it("the shared COUNTER_SALES_MODE_VALUES list equals the registry's modes", () => {
    expect([...COUNTER_SALES_MODE_VALUES]).toEqual(Object.keys(r()!.config!.modes));
  });
});

describe("one fleet resolver: the capability and the 409 agree", () => {
  it.each([
    ["an add-on row", ["order_delivery"], new Map(), true],
    ["no add-on", [], new Map(), false],
    ["a GRANT override", [], new Map([["recurring_routes", "GRANT"]]), true],
    [
      "a DENY over a held add-on",
      ["recurring_routes"],
      new Map([["recurring_routes", "DENY"]]),
      false,
    ],
  ] as const)("%s", async (_n, active, overrides, fleet) => {
    const getActive = jest.fn().mockResolvedValue([...active]);
    const allAct = jest.fn().mockResolvedValue(new Map(overrides));
    const upsert = jest.fn().mockResolvedValue({});
    const module = await Test.createTestingModule({
      providers: [
        FeatureConfigService,
        {
          provide: PrismaService,
          useValue: {
            tenantFeatureConfig: { upsert },
            tenant: { findUnique: jest.fn().mockResolvedValue({ id: "t1" }) },
          },
        },
        { provide: FeatureConfigStore, useValue: { invalidate: jest.fn() } },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: AddonService, useValue: { getActiveAddons: getActive, hasAddon: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn() } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn(), allActive: allAct } },
      ],
    }).compile();
    const service = module.get(FeatureConfigService);
    const guardAllows = await service
      .set("t1", "fulfilment_model", "delivery", "r", "a")
      .then(() => true)
      .catch(() => false);
    const capFleet = await isFleetHeld({ getActiveAddons: getActive }, { allActive: allAct }, "t1");
    expect(guardAllows).toBe(fleet);
    expect(capFleet).toBe(fleet);
    expect(guardAllows).toBe(capFleet);
  });
});

describe("F-A: PICKUP is a capability method, NOT a FulfillPath value", () => {
  it("the FulfillPath enum has no PICKUP and the order DTO rejects it", async () => {
    expect(Object.values(FulfillPath)).toEqual(["ROUTE", "SHIP"]);
    const bad = plainToInstance(CreateOrderDto, { items: [], fulfillPath: "PICKUP" });
    const errs = await validate(bad as object, { skipMissingProperties: true });
    expect(errs.some((e) => e.property === "fulfillPath")).toBe(true);
  });
});
