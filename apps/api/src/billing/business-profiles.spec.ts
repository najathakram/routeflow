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
  BUSINESS_PROFILES,
  PROFILE_MODULE_KEYS,
  businessProfileByKey,
  describeBusinessProfilePlan,
  planBusinessProfile,
  postApplyViolations,
  toBusinessProfileSummary,
  type BusinessProfileState,
} from "./business-profiles";
import { FEATURE_REGISTRY } from "./feature-registry";
import { FLAG_KEYS } from "./plan-catalog.constants";
import { deriveFulfilmentCapability } from "./fulfilment-capability";

const FLEET_MODULES = ["recurring_routes", "order_delivery", "driver_payments"];

/** A tenant nobody configured: no overrides, no add-ons, every mode at its registry default. */
function unsetTenant(): BusinessProfileState {
  return {
    overrides: new Map(),
    // can(): RequireAddon keys need an add-on row; driver_payments is guard-gated (true by default).
    holds: { recurring_routes: false, order_delivery: false, driver_payments: true },
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

  it("every profile is available and its summary is the shared shape", () => {
    expect(toBusinessProfileSummary(profile("in_store_retailer"))).toEqual({
      key: "in_store_retailer",
      label: "In-store retailer",
      description: expect.any(String),
      available: true,
      modes: { fulfilment_model: "pickup", counter_sales: "on" },
      grants: [],
      denies: FLEET_MODULES,
    });
    expect(BUSINESS_PROFILES.every((p) => toBusinessProfileSummary(p).available)).toBe(true);
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
    ["in_store_retailer", { methods: ["PICKUP"], counter: "always", staffOpensAs: "counter" }],
    [
      "in_store_shipping_retailer",
      { methods: ["PICKUP", "SHIP"], counter: "always", staffOpensAs: "counter" },
    ],
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
});

describe("planBusinessProfile", () => {
  it("delivery distributor on an unset tenant: grants the two fleet add-ons, skips driver payments (already on), sets delivery", () => {
    expect(planBusinessProfile(profile("delivery_distributor"), unsetTenant())).toEqual({
      overrides: [
        { featureKey: "recurring_routes", effect: "GRANT", action: "create" },
        { featureKey: "order_delivery", effect: "GRANT", action: "create" },
        { featureKey: "driver_payments", effect: "GRANT", action: "skip" },
      ],
      modes: [{ key: "fulfilment_model", from: "unset", to: "delivery" }],
    });
  });

  it("shipping wholesaler on an unset tenant: denies only what is on, sets ship", () => {
    expect(planBusinessProfile(profile("shipping_wholesaler"), unsetTenant())).toEqual({
      overrides: [
        { featureKey: "recurring_routes", effect: "DENY", action: "skip" },
        { featureKey: "order_delivery", effect: "DENY", action: "skip" },
        { featureKey: "driver_payments", effect: "DENY", action: "create" },
      ],
      modes: [{ key: "fulfilment_model", from: "unset", to: "ship" }],
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

  it("says when an opposite override is replaced", () => {
    const state = unsetTenant();
    state.overrides.set("order_delivery", "DENY");
    const lines = describeBusinessProfilePlan(
      planBusinessProfile(profile("delivery_distributor"), state),
    );
    const label = FEATURE_REGISTRY.find((f) => f.key === "order_delivery")!.label;
    expect(lines).toContain(`Turn on ${label} (replaces the current "off" override)`);
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
