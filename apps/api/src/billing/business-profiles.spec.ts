/**
 * Business profiles — the registry data and the pure planner. Red-first: written before
 * business-profiles.ts existed.
 *
 * A profile is data: which of the EXISTING fleet modules it turns on or off, and which config
 * modes it sets. The planner turns that plus the tenant's current state into create/replace/skip
 * actions and the mode changes; the describer turns a plan into plain English.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  BILLING_DISABLE_ORDER,
  BUSINESS_PROFILES,
  PROFILE_MODULE_KEYS,
  businessProfileByKey,
  describeBusinessProfilePlan,
  describeBusinessProfileSections,
  planBusinessProfile,
  postApplyViolations,
  toBusinessProfileSummary,
  unavailableModes,
  type BusinessProfileState,
} from "./business-profiles";
import * as featureRegistry from "./feature-registry";
import { FEATURE_REGISTRY } from "./feature-registry";
import { FLAG_KEYS } from "./plan-catalog.constants";
import { deriveFulfilmentCapability } from "./fulfilment-capability";

const FLEET_MODULES = ["recurring_routes", "order_delivery", "driver_payments"];

/** A tenant nobody configured: no overrides, no add-ons, every mode at its registry default. */
function unsetTenant(): BusinessProfileState {
  return {
    overrides: new Map(),
    // The real gates: an active override decides, else an add-on row (driver-payments.guard.ts
    // included — it is NOT on by default, SA-671 M2).
    holds: { recurring_routes: false, order_delivery: false, driver_payments: false },
    // Modules held through an add-on row the tenant PAYS for (a Stripe item or a price).
    paying: new Set(),
    modes: { fulfilment_model: "unset", counter_sales: "unset" },
  };
}

function profile(key: string) {
  const def = businessProfileByKey(key);
  if (!def) throw new Error(`no profile ${key}`);
  return def;
}

describe("business profile registry", () => {
  it("has exactly the four profiles, in picker order", () => {
    expect(BUSINESS_PROFILES.map((p) => [p.key, p.label])).toEqual([
      ["delivery_distributor", "Delivery distributor"],
      ["shipping_wholesaler", "Shipping wholesaler"],
      ["in_store_retailer", "In-store retailer"],
      ["in_store_shipping_retailer", "In-store + shipping retailer"],
    ]);
  });

  it("keys match the shared contract's BUSINESS_PROFILE_KEYS exactly", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shared = require("@routeflow/types") as { BUSINESS_PROFILE_KEYS?: readonly string[] };
    expect(BUSINESS_PROFILES.map((p) => p.key)).toEqual(shared.BUSINESS_PROFILE_KEYS);
  });

  it("modules are the EXISTING switches only — registered keys, no plan flag, no new key", () => {
    expect([...PROFILE_MODULE_KEYS]).toEqual(FLEET_MODULES);
    const registered = new Set(FEATURE_REGISTRY.map((f) => f.key));
    for (const p of BUSINESS_PROFILES) {
      for (const key of [
        ...toBusinessProfileSummary(p).grants,
        ...toBusinessProfileSummary(p).denies,
      ]) {
        expect(FLEET_MODULES).toContain(key);
        expect(registered.has(key)).toBe(true);
        expect((FLAG_KEYS as readonly string[]).includes(key)).toBe(false);
      }
    }
  });

  it("each profile's fleet and modes are exactly the spec", () => {
    const shape = BUSINESS_PROFILES.map((p) => {
      const s = toBusinessProfileSummary(p);
      return { key: p.key, grants: s.grants, denies: s.denies, modes: s.modes };
    });
    expect(shape).toEqual([
      {
        key: "delivery_distributor",
        grants: FLEET_MODULES,
        denies: [],
        modes: { fulfilment_model: "delivery" },
      },
      {
        key: "shipping_wholesaler",
        grants: [],
        denies: FLEET_MODULES,
        modes: { fulfilment_model: "ship" },
      },
      {
        key: "in_store_retailer",
        grants: [],
        denies: FLEET_MODULES,
        modes: { fulfilment_model: "pickup", counter_sales: "on" },
      },
      {
        key: "in_store_shipping_retailer",
        grants: [],
        denies: FLEET_MODULES,
        modes: { fulfilment_model: "pickup_ship", counter_sales: "on" },
      },
    ]);
  });

  it("grants driver_payments only after a fleet key (its requires.anyOf is met first)", () => {
    const grants = toBusinessProfileSummary(profile("delivery_distributor")).grants;
    const dp = grants.indexOf("driver_payments");
    expect(dp).toBeGreaterThan(grants.indexOf("recurring_routes"));
    expect(dp).toBeGreaterThan(grants.indexOf("order_delivery"));
  });

  it("every mode a profile sets is a registered mode of that config key", () => {
    for (const p of BUSINESS_PROFILES) {
      for (const [key, mode] of Object.entries(p.modes)) {
        const row = FEATURE_REGISTRY.find((f) => f.key === key);
        expect(row?.config).toBeDefined();
        expect(Object.keys(row!.config!.modes)).toContain(mode);
      }
    }
  });

  it("summary is the shared shape", () => {
    expect(toBusinessProfileSummary(profile("in_store_retailer"))).toEqual({
      key: "in_store_retailer",
      label: "In-store retailer",
      description: expect.any(String),
      available: false,
      modes: { fulfilment_model: "pickup", counter_sales: "on" },
      grants: [],
      denies: FLEET_MODULES,
    });
  });

  it("`available` comes from the feature registry: every mode the profile sets must be available (SA-671 M1)", () => {
    for (const p of BUSINESS_PROFILES) {
      const fromRegistry = Object.entries(p.modes).every(
        ([key, mode]) =>
          FEATURE_REGISTRY.find((f) => f.key === key)?.config?.modes[mode]?.available === true,
      );
      expect(toBusinessProfileSummary(p).available).toBe(fromRegistry);
    }
  });

  it("today: delivery and shipping are available; both in-store profiles are not (pickup modes wait for the counter-sale work)", () => {
    expect(BUSINESS_PROFILES.map((p) => [p.key, toBusinessProfileSummary(p).available])).toEqual([
      ["delivery_distributor", true],
      ["shipping_wholesaler", true],
      ["in_store_retailer", false],
      ["in_store_shipping_retailer", false],
    ]);
    expect(unavailableModes(profile("in_store_shipping_retailer"))).toEqual([
      { key: "fulfilment_model", mode: "pickup_ship" },
    ]);
    expect(unavailableModes(profile("shipping_wholesaler"))).toEqual([]);
  });
});

describe("no second resolver — the applied profile reads through deriveFulfilmentCapability", () => {
  it("UNSET is today exactly: the capability a never-profiled tenant gets is unchanged", () => {
    expect(
      deriveFulfilmentCapability({ mode: "unset", counterSales: "unset", fleet: false }),
    ).toEqual({
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

  it.each([
    ["delivery_distributor", { methods: ["ROUTE"], counter: "off", staffOpensAs: "order" }],
    ["shipping_wholesaler", { methods: ["SHIP"], counter: "off", staffOpensAs: "order" }],
  ])("%s lands on a consistent capability", (key, expected) => {
    const p = profile(key);
    const fleet = toBusinessProfileSummary(p).grants.length > 0;
    const cap = deriveFulfilmentCapability({
      mode: p.modes.fulfilment_model,
      counterSales: p.modes.counter_sales ?? "unset",
      fleet,
    });
    expect(cap).toMatchObject({ ...expected, consistent: true, fleet });
  });

  // SA-666a/b: the in-store modes are UNAVAILABLE in the registry today (no counter flow), so a
  // stored pickup / pickup_ship derives as unset (ROUTE + SHIP, staff opens an order) while
  // counter_sales "on" still offers the optional counter. The registry is as shipped here.
  it.each([
    ["in_store_retailer", "pickup"],
    ["in_store_shipping_retailer", "pickup_ship"],
  ])(
    "%s (%s, registry unavailable today) derives as unset with an optional counter",
    (key, mode) => {
      const p = profile(key);
      expect(p.modes.fulfilment_model).toBe(mode);
      expect(p.modes.counter_sales).toBe("on");
      expect(
        FEATURE_REGISTRY.find((r) => r.key === "fulfilment_model")!.config!.modes[mode],
      ).toMatchObject({ available: false });
      expect(
        deriveFulfilmentCapability({
          mode: p.modes.fulfilment_model,
          counterSales: p.modes.counter_sales!,
          fleet: false,
        }),
      ).toEqual({
        methods: ["ROUTE", "SHIP"],
        staffDefault: "ROUTE",
        staffOpensAs: "order",
        portalMethods: [],
        portalDefault: null,
        counter: "optional",
        fleet: false,
        consistent: true,
      });
    },
  );
});

// The twin of the cases above with the registry mode stubbed AVAILABLE: what the same profiles
// derive once the counter-sale work flips the pickup modes on (no production-code change).
describe("no second resolver — the in-store profiles once the registry offers pickup", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function stubPickupAvailable() {
    const real = featureRegistry.featureDefByKey;
    return jest.spyOn(featureRegistry, "featureDefByKey").mockImplementation((key: string) => {
      const def = real(key);
      if (key !== "fulfilment_model" || !def?.config) return def;
      const modes = Object.fromEntries(
        Object.entries(def.config.modes).map(([m, v]) => [
          m,
          m === "pickup" || m === "pickup_ship" ? { ...v, available: true } : v,
        ]),
      );
      return { ...def, config: { ...def.config, modes } };
    });
  }

  it.each([
    ["in_store_retailer", ["PICKUP"]],
    ["in_store_shipping_retailer", ["PICKUP", "SHIP"]],
  ])("%s derives the in-store capability when pickup is available", (key, methods) => {
    stubPickupAvailable();
    const p = profile(key);
    expect(
      deriveFulfilmentCapability({
        mode: p.modes.fulfilment_model,
        counterSales: p.modes.counter_sales!,
        fleet: false,
      }),
    ).toEqual({
      methods,
      // methods[0]: the resolver's staffDefault is the first method in the mode's list
      staffDefault: "PICKUP",
      staffOpensAs: "counter",
      portalMethods: methods,
      portalDefault: "PICKUP",
      counter: "always",
      fleet: false,
      consistent: true,
    });
  });
});

describe("planBusinessProfile", () => {
  it("delivery distributor on an unset tenant: grants all three modules (driver payments is NOT on by default), sets delivery", () => {
    expect(planBusinessProfile(profile("delivery_distributor"), unsetTenant())).toEqual({
      overrides: [
        { featureKey: "recurring_routes", effect: "GRANT", action: "create" },
        { featureKey: "order_delivery", effect: "GRANT", action: "create" },
        { featureKey: "driver_payments", effect: "GRANT", action: "create" },
      ],
      modes: [{ key: "fulfilment_model", from: "unset", to: "delivery" }],
      billing: [],
    });
  });

  it("shipping wholesaler on an unset tenant: nothing is on, so nothing is denied; sets ship", () => {
    expect(planBusinessProfile(profile("shipping_wholesaler"), unsetTenant())).toEqual({
      overrides: [
        { featureKey: "recurring_routes", effect: "DENY", action: "skip" },
        { featureKey: "order_delivery", effect: "DENY", action: "skip" },
        { featureKey: "driver_payments", effect: "DENY", action: "skip" },
      ],
      modes: [{ key: "fulfilment_model", from: "unset", to: "ship" }],
      billing: [],
    });
  });

  it("an opposite active override is REPLACED, a held add-on is denied with a new override", () => {
    const state = unsetTenant();
    state.overrides.set("recurring_routes", "GRANT");
    state.holds = { recurring_routes: true, order_delivery: true, driver_payments: true };
    const plan = planBusinessProfile(profile("in_store_retailer"), state);
    expect(plan.overrides).toEqual([
      { featureKey: "recurring_routes", effect: "DENY", action: "replace" },
      { featureKey: "order_delivery", effect: "DENY", action: "create" },
      { featureKey: "driver_payments", effect: "DENY", action: "create" },
    ]);
    expect(plan.modes).toEqual([
      { key: "fulfilment_model", from: "unset", to: "pickup" },
      { key: "counter_sales", from: "unset", to: "on" },
    ]);
  });

  it("a DENY override on a fleet key is replaced by the GRANT", () => {
    const state = unsetTenant();
    state.overrides.set("order_delivery", "DENY");
    const plan = planBusinessProfile(profile("delivery_distributor"), state);
    expect(plan.overrides[1]).toEqual({
      featureKey: "order_delivery",
      effect: "GRANT",
      action: "replace",
    });
  });

  it("a tenant that already matches gets an all-skip plan with no mode changes", () => {
    const state: BusinessProfileState = {
      overrides: new Map([["driver_payments", "DENY"]]),
      holds: { recurring_routes: false, order_delivery: false, driver_payments: false },
      modes: { fulfilment_model: "ship", counter_sales: "unset" },
    };
    const plan = planBusinessProfile(profile("shipping_wholesaler"), state);
    expect(plan.overrides.every((o) => o.action === "skip")).toBe(true);
    expect(plan.modes).toEqual([]);
    expect(describeBusinessProfilePlan(plan)).toEqual([]);
  });
});

describe("postApplyViolations — validate the WHOLE post-apply state before writing anything", () => {
  it("no profile is refused from an unset tenant, and none from any other profile's end state", () => {
    const endState = (key: string): BusinessProfileState => {
      const s = toBusinessProfileSummary(profile(key));
      const holds: Record<string, boolean> = { driver_payments: true };
      for (const k of s.grants) holds[k] = true;
      for (const k of s.denies) holds[k] = false;
      return {
        overrides: new Map([
          ...s.grants.map((k) => [k, "GRANT"] as const),
          ...s.denies.map((k) => [k, "DENY"] as const),
        ]),
        holds,
        modes: { fulfilment_model: "unset", counter_sales: "unset", ...s.modes },
      };
    };
    const starts = [unsetTenant(), ...BUSINESS_PROFILES.map((p) => endState(p.key))];
    for (const start of starts) {
      for (const target of BUSINESS_PROFILES) {
        expect(postApplyViolations(target, start)).toEqual([]);
      }
    }
  });

  it("refuses a delivery mode whose post-apply state holds no fleet key", () => {
    const deliveryNoFleet = { ...profile("delivery_distributor"), fleet: false };
    expect(postApplyViolations(deliveryNoFleet, unsetTenant())).toEqual([
      { code: "FULFILMENT_MODE_NEEDS_FLEET", key: "fulfilment_model", mode: "delivery" },
    ]);
  });
});

describe("describeBusinessProfileSections — billing kept apart from the rest (#3220 review)", () => {
  it("billing holds one line per plan.billing entry; changes holds everything else; summary = both", () => {
    const plan = {
      overrides: [
        { featureKey: "recurring_routes", effect: "GRANT" as const, action: "create" as const },
        { featureKey: "driver_payments", effect: "DENY" as const, action: "skip" as const },
      ],
      modes: [{ key: "fulfilment_model", from: "unset", to: "ship" }],
      billing: [{ featureKey: "driver_payments", action: "disable" as const, manual: true }],
    };
    const { billing, changes } = describeBusinessProfileSections(plan);
    expect(billing).toHaveLength(1);
    expect(billing[0]).toMatch(/manual invoice/);
    expect(changes.some((l) => /billing|manual invoice/.test(l))).toBe(false);
    expect(changes[0]).toContain("turned on free (comp), no charge added");
    expect(describeBusinessProfilePlan(plan)).toEqual([...billing, ...changes]);
  });
});

describe("describeBusinessProfilePlan — the plain-English preview", () => {
  it("names modules by their registry label and modes by their mode labels; skips say nothing", () => {
    const plan = planBusinessProfile(profile("shipping_wholesaler"), {
      ...unsetTenant(),
      holds: { recurring_routes: true, order_delivery: false, driver_payments: true },
    });
    const label = (key: string) => FEATURE_REGISTRY.find((f) => f.key === key)!.label;
    expect(describeBusinessProfilePlan(plan)).toEqual([
      // apply order: grants → modes → denies (the mode leaves delivery before a fleet goes off)
      "How orders reach customers: Not configured (today's behavior) → Ship by carrier",
      `Turn off ${label("recurring_routes")}`,
      `Turn off ${label("driver_payments")}`,
    ]);
  });

  it("OWNER RULING: a module the tenant PAYS for is switched off by disabling its add-on (billing stops), not by a DENY", () => {
    const label = (key: string) => FEATURE_REGISTRY.find((f) => f.key === key)!.label;
    const plan = planBusinessProfile(profile("shipping_wholesaler"), {
      ...unsetTenant(),
      // recurring_routes: a paid row; order_delivery: a COMPED row (no Stripe item, no price)
      holds: { recurring_routes: true, order_delivery: true, driver_payments: false },
      paying: new Set(["recurring_routes"]),
    });
    expect(plan.overrides).toEqual([
      { featureKey: "recurring_routes", effect: "DENY", action: "skip" },
      { featureKey: "order_delivery", effect: "DENY", action: "create" },
      { featureKey: "driver_payments", effect: "DENY", action: "skip" },
    ]);
    expect(plan.billing).toEqual([
      { featureKey: "recurring_routes", action: "disable", manual: false },
    ]);
    expect(describeBusinessProfilePlan(plan)).toEqual([
      `${label("recurring_routes")} will be switched off and its billing stopped`,
      "How orders reach customers: Not configured (today's behavior) → Ship by carrier",
      `Turn off ${label("order_delivery")}`,
    ]);
  });

  it("a paid module ALSO held by a GRANT override: the override is replaced AND the add-on disabled", () => {
    const state = unsetTenant();
    state.overrides.set("order_delivery", "GRANT");
    state.holds = { recurring_routes: false, order_delivery: true, driver_payments: false };
    state.paying = new Set(["order_delivery"]);
    const plan = planBusinessProfile(profile("shipping_wholesaler"), state);
    expect(plan.overrides[1]).toEqual({
      featureKey: "order_delivery",
      effect: "DENY",
      action: "replace",
    });
    expect(plan.billing).toEqual([
      { featureKey: "order_delivery", action: "disable", manual: false },
    ]);
  });

  it("a paid module that is already off (DENY override) still has its billing stopped", () => {
    const state = unsetTenant();
    state.overrides.set("recurring_routes", "DENY");
    state.paying = new Set(["recurring_routes"]);
    const plan = planBusinessProfile(profile("shipping_wholesaler"), state);
    expect(plan.overrides[0].action).toBe("skip");
    expect(plan.billing).toEqual([
      { featureKey: "recurring_routes", action: "disable", manual: false },
    ]);
  });

  it("LEAD RULING: paid add-ons are disabled in REVERSE dependency order (driver payments first, the last fleet key last)", () => {
    expect([...BILLING_DISABLE_ORDER]).toEqual([
      "driver_payments",
      "order_delivery",
      "recurring_routes",
    ]);
    const dp = FEATURE_REGISTRY.find((f) => f.key === "driver_payments")!;
    // driver_payments depends on the fleet keys, so it must go before any of them
    expect(dp.requires?.anyOf).toEqual(
      expect.arrayContaining(["recurring_routes", "order_delivery"]),
    );
    const plan = planBusinessProfile(profile("shipping_wholesaler"), {
      ...unsetTenant(),
      holds: { recurring_routes: true, order_delivery: true, driver_payments: true },
      paying: new Set(["recurring_routes", "order_delivery", "driver_payments"]),
    });
    expect(plan.billing.map((b) => b.featureKey)).toEqual([
      "driver_payments",
      "order_delivery",
      "recurring_routes",
    ]);
  });

  it("SA SHOULD: a MANUAL-pay add-on (a price, no Stripe item) is disabled too, but the preview tells the admin to remove it from the manual invoice", () => {
    const label = (key: string) => FEATURE_REGISTRY.find((f) => f.key === key)!.label;
    const plan = planBusinessProfile(profile("shipping_wholesaler"), {
      ...unsetTenant(),
      holds: { recurring_routes: true, order_delivery: true, driver_payments: false },
      paying: new Set(["recurring_routes", "order_delivery"]),
      manualPay: new Set(["recurring_routes"]),
    });
    expect(plan.billing).toEqual([
      { featureKey: "order_delivery", action: "disable", manual: false },
      { featureKey: "recurring_routes", action: "disable", manual: true },
    ]);
    expect(describeBusinessProfilePlan(plan).slice(0, 2)).toEqual([
      `${label("order_delivery")} will be switched off and its billing stopped`,
      `${label("recurring_routes")} will be switched off; remove it from their manual invoice`,
    ]);
  });

  it("a profile that turns the fleet ON never disables billing", () => {
    const state = unsetTenant();
    state.paying = new Set(["recurring_routes"]);
    state.holds.recurring_routes = true;
    expect(planBusinessProfile(profile("delivery_distributor"), state).billing).toEqual([]);
  });

  it("says when an opposite override is replaced", () => {
    const state = unsetTenant();
    state.overrides.set("order_delivery", "DENY");
    const lines = describeBusinessProfilePlan(
      planBusinessProfile(profile("delivery_distributor"), state),
    );
    const label = FEATURE_REGISTRY.find((f) => f.key === "order_delivery")!.label;
    expect(lines).toContain(
      `Turn on ${label}: turned on free (comp), no charge added (replaces the current "off" override)`,
    );
  });
});

describe("never writes PICKUP orders", () => {
  it("the profile files never touch an order's fulfillPath", () => {
    for (const file of ["business-profiles.ts", "business-profile.service.ts"]) {
      const text = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(text).not.toMatch(/fulfillPath/);
      expect(text).not.toMatch(/\.order\.|prisma\.order\b/);
    }
  });
});
