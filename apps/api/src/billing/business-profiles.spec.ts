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
import { ticksToProfileDef } from "./business-capabilities";
import {
  BILLING_DISABLE_ORDER,
  BUSINESS_PROFILES,
  PROFILE_MODULE_KEYS,
  businessProfileByKey,
  describeBusinessProfilePlan,
  describeBusinessProfileSections,
  planBusinessProfile,
  planCompRefusal,
  postApplyViolations,
  toBusinessProfileSummary,
  unavailableModes,
  type BusinessProfileDef,
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
    // The real gates: an active override decides, else an add-on row (driver-payments.guard.ts
    // included — it is NOT on by default, SA-671 M2).
    holds: { recurring_routes: false, order_delivery: false, driver_payments: false },
    // Modules held through an add-on row the tenant PAYS for (a Stripe item or a price).
    paying: new Set(),
    // SA-769: modules with an ACTIVE add-on row (billable or comp), and the subset that is a comp.
    rowHeld: new Set(),
    compRows: new Set(),
    modes: { fulfilment_model: "unset", counter_sales: "unset" },
  };
}

function profile(key: string) {
  const def = businessProfileByKey(key);
  if (!def) throw new Error(`no profile ${key}`);
  return def;
}

describe("business profile registry", () => {
  it("has exactly the seven profiles, in picker order (BO-04: + Delivery + shipping, Everything)", () => {
    expect(BUSINESS_PROFILES.map((p) => [p.key, p.label])).toEqual([
      ["delivery_distributor", "Delivery distributor"],
      ["shipping_wholesaler", "Shipping wholesaler"],
      ["in_store_retailer", "In-store retailer"],
      ["in_store_shipping_retailer", "In-store + shipping retailer"],
      ["delivery_pos", "Delivery + POS"],
      ["delivery_shipping", "Delivery + shipping"],
      ["delivery_shipping_pos", "Everything"],
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
        // BO-04: counter_sales is ALWAYS written ("unset" = no counter), so a profile can switch it off
        modes: { fulfilment_model: "delivery", counter_sales: "unset" },
      },
      {
        key: "shipping_wholesaler",
        grants: [],
        denies: FLEET_MODULES,
        modes: { fulfilment_model: "ship", counter_sales: "unset" },
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
      {
        key: "delivery_pos",
        grants: FLEET_MODULES,
        denies: [],
        modes: { fulfilment_model: "delivery", counter_sales: "on" },
      },
      {
        key: "delivery_shipping",
        grants: FLEET_MODULES,
        denies: [],
        modes: { fulfilment_model: "both", counter_sales: "unset" },
      },
      {
        key: "delivery_shipping_pos",
        grants: FLEET_MODULES,
        denies: [],
        modes: { fulfilment_model: "both", counter_sales: "on" },
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
      available: true,
      modes: { fulfilment_model: "pickup", counter_sales: "on" },
      grants: [],
      denies: FLEET_MODULES,
      // BO-03: additive - what picking this preset pre-ticks
      ticks: {
        delivery: false,
        doorPayments: false,
        shipping: false,
        counter: true,
        opensAs: "counter",
      },
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

  it("every profile is available: the in-store profiles too, now that the pickup modes are (registry flip)", () => {
    expect(BUSINESS_PROFILES.map((p) => [p.key, toBusinessProfileSummary(p).available])).toEqual([
      ["delivery_distributor", true],
      ["shipping_wholesaler", true],
      ["in_store_retailer", true],
      ["in_store_shipping_retailer", true],
      ["delivery_pos", true],
      ["delivery_shipping", true],
      ["delivery_shipping_pos", true],
    ]);
    expect(unavailableModes(profile("in_store_shipping_retailer"))).toEqual([]);
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
    // delivery + counter: ROUTE orders with an optional counter (not an in-store-only mode)
    ["delivery_pos", { methods: ["ROUTE"], counter: "optional", staffOpensAs: "order" }],
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

  // SA-666a/b, post-flip: the in-store modes are AVAILABLE in the registry as shipped, so a stored
  // pickup / pickup_ship derives the in-store capability (the registry is read, never stubbed here).
  it.each([
    ["in_store_retailer", "pickup", ["PICKUP"]],
    ["in_store_shipping_retailer", "pickup_ship", ["PICKUP", "SHIP"]],
  ])("%s (%s, registry available) derives the in-store capability", (key, mode, methods) => {
    const p = profile(key);
    expect(p.modes.fulfilment_model).toBe(mode);
    expect(p.modes.counter_sales).toBe("on");
    expect(
      FEATURE_REGISTRY.find((r) => r.key === "fulfilment_model")!.config!.modes[mode],
    ).toMatchObject({ available: true });
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
  it("SA-769: delivery distributor on an unset tenant COMPS all three modules (driver payments is NOT on by default), writes no GRANT override, sets delivery", () => {
    expect(planBusinessProfile(profile("delivery_distributor"), unsetTenant())).toEqual({
      // a comp row replaces the GRANT override: nothing for the override path to create
      overrides: [
        { featureKey: "recurring_routes", effect: "GRANT", action: "skip" },
        { featureKey: "order_delivery", effect: "GRANT", action: "skip" },
        { featureKey: "driver_payments", effect: "GRANT", action: "skip" },
      ],
      // order unchanged: the fleet keys first, driver_payments last
      comps: [
        { featureKey: "recurring_routes" },
        { featureKey: "order_delivery" },
        { featureKey: "driver_payments" },
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
      comps: [],
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

  it("SA-769: a DENY override on a fleet key is REVOKED (nothing created) and the module comped when no add-on row holds it", () => {
    const state = unsetTenant();
    state.overrides.set("order_delivery", "DENY");
    const plan = planBusinessProfile(profile("delivery_distributor"), state);
    expect(plan.overrides[1]).toEqual({
      featureKey: "order_delivery",
      effect: "GRANT",
      action: "revoke",
    });
    expect(plan.comps.map((c) => c.featureKey)).toEqual([
      "recurring_routes",
      "order_delivery",
      "driver_payments",
    ]);
  });

  it("SA-769: a DENY override over an ACTIVE add-on row is only revoked: the row already holds the module, no comp", () => {
    const state = unsetTenant();
    state.overrides.set("order_delivery", "DENY");
    state.rowHeld = new Set(["order_delivery"]);
    const plan = planBusinessProfile(profile("delivery_distributor"), state);
    expect(plan.overrides[1].action).toBe("revoke");
    expect(plan.comps.map((c) => c.featureKey)).not.toContain("order_delivery");
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

describe("SA-769 planBusinessProfile — never re-price what exists", () => {
  const heldBy = (state: BusinessProfileState, key: string) => {
    state.holds[key] = true;
    state.rowHeld = new Set([...(state.rowHeld ?? []), key]);
    return state;
  };

  it("a module the tenant already PAYS for stays billable: no comp, no billing change, no override", () => {
    const state = heldBy(unsetTenant(), "order_delivery");
    state.paying = new Set(["order_delivery"]);
    const plan = planBusinessProfile(profile("delivery_distributor"), state);
    expect(plan.comps.map((c) => c.featureKey)).toEqual(["recurring_routes", "driver_payments"]);
    expect(plan.overrides.find((o) => o.featureKey === "order_delivery")?.action).toBe("skip");
    expect(plan.billing).toEqual([]);
  });

  it("an existing comp row is left alone (held: nothing to comp)", () => {
    const state = heldBy(unsetTenant(), "recurring_routes");
    state.compRows = new Set(["recurring_routes"]);
    const plan = planBusinessProfile(profile("delivery_distributor"), state);
    expect(plan.comps.map((c) => c.featureKey)).toEqual(["order_delivery", "driver_payments"]);
  });

  it("an existing GRANT override is left alone (no comp, no revoke, no create)", () => {
    const state = unsetTenant();
    state.overrides.set("driver_payments", "GRANT");
    state.holds.driver_payments = true;
    const plan = planBusinessProfile(profile("delivery_distributor"), state);
    expect(plan.overrides.find((o) => o.featureKey === "driver_payments")?.action).toBe("skip");
    expect(plan.comps.map((c) => c.featureKey)).toEqual(["recurring_routes", "order_delivery"]);
  });

  it("idempotent: a tenant whose modules are all held by comp rows plans no comp at all", () => {
    const state = unsetTenant();
    for (const k of FLEET_MODULES) heldBy(state, k);
    state.compRows = new Set(FLEET_MODULES);
    const plan = planBusinessProfile(profile("delivery_distributor"), state);
    expect(plan.comps).toEqual([]);
    expect(plan.overrides.every((o) => o.action === "skip")).toBe(true);
    expect(describeBusinessProfilePlan(plan)).toEqual([
      "Where orders go: Not configured (today's behavior) → Own delivery",
    ]);
  });

  it("a fleet:false profile switches a COMP row off through the disable path (BILLING_DISABLE_ORDER), flagged comp, with no DENY override", () => {
    const state = unsetTenant();
    for (const k of FLEET_MODULES) heldBy(state, k);
    state.compRows = new Set(FLEET_MODULES);
    const plan = planBusinessProfile(profile("shipping_wholesaler"), state);
    expect(plan.comps).toEqual([]);
    expect(plan.billing).toEqual([
      { featureKey: "driver_payments", action: "disable", manual: false, comp: true },
      { featureKey: "order_delivery", action: "disable", manual: false, comp: true },
      { featureKey: "recurring_routes", action: "disable", manual: false, comp: true },
    ]);
    expect(plan.overrides.every((o) => o.action === "skip")).toBe(true);
  });

  it("a PAID row and a COMP row side by side: the paid one stays a billing stop, the comp one is flagged comp", () => {
    const state = unsetTenant();
    heldBy(state, "recurring_routes");
    heldBy(state, "order_delivery");
    state.paying = new Set(["recurring_routes"]);
    state.compRows = new Set(["order_delivery"]);
    const plan = planBusinessProfile(profile("shipping_wholesaler"), state);
    expect(plan.billing).toEqual([
      { featureKey: "order_delivery", action: "disable", manual: false, comp: true },
      { featureKey: "recurring_routes", action: "disable", manual: false },
    ]);
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
      comps: [],
      modes: [{ key: "fulfilment_model", from: "unset", to: "ship" }],
      billing: [{ featureKey: "driver_payments", action: "disable" as const, manual: true }],
    };
    const { billing, comps, changes } = describeBusinessProfileSections(plan);
    expect(billing).toHaveLength(1);
    expect(billing[0]).toMatch(/manual invoice/);
    expect(comps).toEqual([]);
    expect(changes.some((l) => /billing|manual invoice/.test(l))).toBe(false);
    expect(changes[0]).toContain("turned on free (comp), no charge added");
    expect(describeBusinessProfilePlan(plan)).toEqual([...billing, ...comps, ...changes]);
  });

  it('SA-769: comps get their own lines ("Included free with this profile"), kept out of changes; summary = billing, comps, changes', () => {
    const plan = planBusinessProfile(profile("delivery_distributor"), unsetTenant());
    const { billing, comps, changes } = describeBusinessProfileSections(plan);
    const label = (key: string) => FEATURE_REGISTRY.find((f) => f.key === key)!.label;
    expect(billing).toEqual([]);
    expect(comps).toEqual(
      FLEET_MODULES.map(
        (k) => `Turn on ${label(k)}: included free with this profile, no charge added`,
      ),
    );
    expect(changes).toEqual(["Where orders go: Not configured (today's behavior) → Own delivery"]);
    expect(describeBusinessProfilePlan(plan)).toEqual([...comps, ...changes]);
  });

  it("SA-769: a comp row switched off by a fleet:false profile says it was free and nothing is billed", () => {
    const state = unsetTenant();
    state.holds.recurring_routes = true;
    state.rowHeld = new Set(["recurring_routes"]);
    state.compRows = new Set(["recurring_routes"]);
    const plan = planBusinessProfile(profile("shipping_wholesaler"), state);
    expect(describeBusinessProfileSections(plan).billing).toEqual([
      "Recurring routes will be switched off (it was included free; nothing is billed)",
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
      "Where orders go: Not configured (today's behavior) → Ship by carrier",
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
      "Where orders go: Not configured (today's behavior) → Ship by carrier",
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
    // SA-769: the DENY is revoked on its own line; the comp row is its own "included free" line
    expect(lines).toContain(`Remove the "off" override on ${label}`);
    expect(lines).toContain(`Turn on ${label}: included free with this profile, no charge added`);
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

/**
 * BO-04: the capability ticks plan through the SAME planner. `counter_sales` is always written, and a def may carry
 * a per-module map (`modules`) that overrides `fleet`. Billing stays BILLING_DISABLE_ORDER, filtered, never reordered.
 */
describe("BO-04 planBusinessProfile — ticks as input", () => {
  const ticks = (t: Parameters<typeof ticksToProfileDef>[0]) => ticksToProfileDef(t).def;
  const paidAll = (): BusinessProfileState => {
    const s = unsetTenant();
    s.holds = { recurring_routes: true, order_delivery: true, driver_payments: true };
    s.rowHeld = new Set(FLEET_MODULES);
    s.paying = new Set(FLEET_MODULES);
    return s;
  };
  const counterOn = (s: BusinessProfileState) => {
    s.modes = { ...s.modes, counter_sales: "on" };
    return s;
  };

  it("Shipping only on a tenant with counter_sales=on plans counter_sales on -> unset (the old preset never did)", () => {
    const state = counterOn(unsetTenant());
    state.modes.fulfilment_model = "ship";
    for (const def of [profile("shipping_wholesaler"), ticks({ shipping: true })]) {
      expect(planBusinessProfile(def, state).modes).toEqual([
        { key: "counter_sales", from: "on", to: "unset" },
      ]);
    }
  });

  it("Delivery on a Delivery + counter tenant plans counter_sales on -> unset", () => {
    const state = counterOn(unsetTenant());
    state.modes.fulfilment_model = "delivery";
    for (const def of [profile("delivery_distributor"), ticks({ delivery: true })]) {
      expect(planBusinessProfile(def, state).modes).toEqual([
        { key: "counter_sales", from: "on", to: "unset" },
      ]);
    }
  });

  it("{delivery, shipping} plans fulfilment_model=both and comps the fleet keys the tenant lacks", () => {
    const state = unsetTenant();
    state.holds.order_delivery = true;
    state.rowHeld = new Set(["order_delivery"]);
    const plan = planBusinessProfile(ticks({ delivery: true, shipping: true }), state);
    expect(plan.modes).toEqual([{ key: "fulfilment_model", from: "unset", to: "both" }]);
    expect(plan.comps).toEqual([
      { featureKey: "recurring_routes" },
      { featureKey: "driver_payments" },
    ]);
    expect(plan.billing).toEqual([]);
  });

  it("{delivery, doorPayments:false} on a tenant paying driver_payments plans a billing stop for it and comps the two fleet keys", () => {
    const state = unsetTenant();
    state.holds.driver_payments = true;
    state.rowHeld = new Set(["driver_payments"]);
    state.paying = new Set(["driver_payments"]);
    const plan = planBusinessProfile(ticks({ delivery: true, doorPayments: false }), state);
    expect(plan.billing).toEqual([
      { featureKey: "driver_payments", action: "disable", manual: false },
    ]);
    expect(plan.comps).toEqual([
      { featureKey: "recurring_routes" },
      { featureKey: "order_delivery" },
    ]);
    expect(plan.overrides).toEqual([
      { featureKey: "recurring_routes", effect: "GRANT", action: "skip" },
      { featureKey: "order_delivery", effect: "GRANT", action: "skip" },
      { featureKey: "driver_payments", effect: "DENY", action: "skip" },
    ]);
  });

  it("{delivery, doorPayments:false} on a tenant holding driver_payments by a comp row switches it off as a comp", () => {
    const state = unsetTenant();
    state.holds.driver_payments = true;
    state.rowHeld = new Set(["driver_payments"]);
    state.compRows = new Set(["driver_payments"]);
    const plan = planBusinessProfile(ticks({ delivery: true, doorPayments: false }), state);
    expect(plan.billing).toEqual([
      { featureKey: "driver_payments", action: "disable", manual: false, comp: true },
    ]);
  });

  it("{shipping} with all three modules paid disables them in BILLING_DISABLE_ORDER", () => {
    const plan = planBusinessProfile(ticks({ shipping: true }), paidAll());
    expect(plan.billing.map((b) => b.featureKey)).toEqual([...BILLING_DISABLE_ORDER]);
    expect(plan.comps).toEqual([]);
  });

  it("a per-module map filters the disable order, never reorders it", () => {
    const def: BusinessProfileDef = {
      ...profile("delivery_distributor"),
      key: "custom",
      modules: { recurring_routes: false, order_delivery: true, driver_payments: false },
    };
    const plan = planBusinessProfile(def, paidAll());
    expect(plan.billing.map((b) => b.featureKey)).toEqual(["driver_payments", "recurring_routes"]);
    expect(toBusinessProfileSummary(def)).toMatchObject({
      grants: ["order_delivery"],
      denies: ["recurring_routes", "driver_payments"],
    });
  });

  it("idempotent: re-planning the ticks' own end state writes nothing", () => {
    for (const t of [
      { delivery: true, shipping: true, counter: true },
      { delivery: true, doorPayments: false },
      { shipping: true },
      { counter: true },
    ]) {
      const def = ticks(t);
      const state = unsetTenant();
      for (const k of FLEET_MODULES) {
        const wants = def.modules?.[k as keyof typeof def.modules] ?? def.fleet;
        state.holds[k] = wants;
        if (wants) {
          state.rowHeld = new Set([...(state.rowHeld ?? []), k]);
          state.compRows = new Set([...(state.compRows ?? []), k]);
        }
      }
      state.modes = { ...state.modes, ...def.modes };
      const plan = planBusinessProfile(def, state);
      expect(plan.modes).toEqual([]);
      expect(plan.comps).toEqual([]);
      expect(plan.billing).toEqual([]);
    }
  });

  it("postApplyViolations respects the per-module map (fleet true but both fleet keys off still needs a fleet)", () => {
    const noFleetKeys: BusinessProfileDef = {
      ...profile("delivery_distributor"),
      key: "custom",
      modules: { recurring_routes: false, order_delivery: false, driver_payments: true },
    };
    expect(postApplyViolations(noFleetKeys, unsetTenant())).toEqual([
      { code: "FULFILMENT_MODE_NEEDS_FLEET", key: "fulfilment_model", mode: "delivery" },
    ]);
    const oneKey: BusinessProfileDef = {
      ...profile("delivery_distributor"),
      fleet: false,
      modules: { recurring_routes: false, order_delivery: true, driver_payments: false },
    };
    expect(postApplyViolations(oneKey, unsetTenant())).toEqual([]);
  });
});

describe("BO-04 planCompRefusal — the comp path's own refusal, dry-run in the plan", () => {
  const oddDef: BusinessProfileDef = {
    ...profile("delivery_distributor"),
    key: "custom",
    // door payments without any fleet key: the comp of driver_payments would be refused (anyOf the fleet keys)
    modules: { recurring_routes: false, order_delivery: false, driver_payments: true },
  };

  it("a comp of driver_payments with no fleet key effective at that point is refused with FEATURE_REQUIRES_UNMET", () => {
    const state = unsetTenant();
    const plan = planBusinessProfile(oddDef, state);
    expect(planCompRefusal(plan, state)).toEqual({
      code: "FEATURE_REQUIRES_UNMET",
      key: "driver_payments",
      missing: expect.stringContaining("Recurring routes"),
    });
  });

  it("the fleet comps that run first satisfy it (every ticks combination, from an unset tenant)", () => {
    for (const t of [
      { delivery: true },
      { delivery: true, shipping: true },
      { delivery: true, counter: true, shipping: true },
      { delivery: true, doorPayments: false },
      { shipping: true },
      { counter: true },
    ]) {
      const state = unsetTenant();
      expect(
        planCompRefusal(planBusinessProfile(ticksToProfileDef(t).def, state), state),
      ).toBeNull();
    }
  });

  it("a DENY override on a fleet key is revoked before the comp, so it does not block driver_payments", () => {
    const state = unsetTenant();
    state.overrides.set("recurring_routes", "DENY");
    state.overrides.set("order_delivery", "DENY");
    const plan = planBusinessProfile(profile("delivery_distributor"), state);
    expect(planCompRefusal(plan, state)).toBeNull();
  });

  it("a fleet key the same apply switches off (billing disable) no longer counts as effective", () => {
    const state = unsetTenant();
    state.holds.recurring_routes = true;
    state.rowHeld = new Set(["recurring_routes"]);
    state.paying = new Set(["recurring_routes"]);
    const plan = planBusinessProfile(oddDef, state);
    expect(plan.billing.map((b) => b.featureKey)).toEqual(["recurring_routes"]);
    expect(planCompRefusal(plan, state)?.key).toBe("driver_payments");
  });

  it("nothing to comp, nothing refused", () => {
    const state = unsetTenant();
    expect(
      planCompRefusal(planBusinessProfile(profile("shipping_wholesaler"), state), state),
    ).toBeNull();
  });
});

/**
 * GUARD (labelled): the five original presets plan EXACTLY as before BO-04, apart from the new counter line.
 * `legacyPlan` is the pre-BO-04 planner, copied here on purpose as the reference.
 */
describe("BO-04 guard — the five original presets plan exactly as before", () => {
  const LEGACY: { key: string; fleet: boolean; modes: Record<string, string> }[] = [
    { key: "delivery_distributor", fleet: true, modes: { fulfilment_model: "delivery" } },
    { key: "shipping_wholesaler", fleet: false, modes: { fulfilment_model: "ship" } },
    {
      key: "in_store_retailer",
      fleet: false,
      modes: { fulfilment_model: "pickup", counter_sales: "on" },
    },
    {
      key: "in_store_shipping_retailer",
      fleet: false,
      modes: { fulfilment_model: "pickup_ship", counter_sales: "on" },
    },
    {
      key: "delivery_pos",
      fleet: true,
      modes: { fulfilment_model: "delivery", counter_sales: "on" },
    },
  ];

  function legacyPlan(
    def: { fleet: boolean; modes: Record<string, string> },
    state: BusinessProfileState,
  ) {
    const effect: "GRANT" | "DENY" = def.fleet ? "GRANT" : "DENY";
    const opposite = def.fleet ? "DENY" : "GRANT";
    const disables = def.fleet
      ? []
      : BILLING_DISABLE_ORDER.filter((k) => state.paying?.has(k) || state.compRows?.has(k));
    const comps: { featureKey: string }[] = [];
    const overrides = PROFILE_MODULE_KEYS.map((featureKey) => {
      const active = state.overrides.get(featureKey);
      const held = disables.includes(featureKey) ? false : (state.holds[featureKey] ?? false);
      if (def.fleet) {
        if (active === "DENY") {
          if (!state.rowHeld?.has(featureKey)) comps.push({ featureKey });
          return { featureKey, effect, action: "revoke" as const };
        }
        if (!held) comps.push({ featureKey });
        return { featureKey, effect, action: "skip" as const };
      }
      const action: "create" | "replace" | "skip" =
        active === opposite ? "replace" : held === def.fleet ? "skip" : "create";
      return { featureKey, effect, action };
    });
    const modes = Object.entries(def.modes)
      .map(([key, to]) => ({ key, from: state.modes[key] ?? "unset", to }))
      .filter((m) => m.from !== m.to);
    return {
      overrides,
      comps,
      modes,
      billing: disables.map((featureKey) => ({
        featureKey,
        action: "disable" as const,
        manual: state.manualPay?.has(featureKey) ?? false,
        ...(!state.paying?.has(featureKey) && state.compRows?.has(featureKey)
          ? { comp: true }
          : {}),
      })),
    };
  }

  const all = FLEET_MODULES;
  const mk = (
    patch: Partial<Omit<BusinessProfileState, "overrides">> & {
      overrides?: [string, "GRANT" | "DENY"][];
    },
  ): BusinessProfileState => {
    const { overrides, ...rest } = patch;
    return { ...unsetTenant(), ...rest, overrides: new Map(overrides ?? []) };
  };
  const heldAll = { recurring_routes: true, order_delivery: true, driver_payments: true };
  const STATES: [string, BusinessProfileState][] = [
    ["unset", mk({})],
    ["paid all", mk({ holds: heldAll, rowHeld: new Set(all), paying: new Set(all) })],
    [
      "manual pay",
      mk({
        holds: heldAll,
        rowHeld: new Set(all),
        paying: new Set(all),
        manualPay: new Set(["driver_payments"]),
      }),
    ],
    ["comp all", mk({ holds: heldAll, rowHeld: new Set(all), compRows: new Set(all) })],
    [
      "paid + comp mix",
      mk({
        holds: heldAll,
        rowHeld: new Set(all),
        paying: new Set(["recurring_routes"]),
        compRows: new Set(["order_delivery", "driver_payments"]),
      }),
    ],
    [
      "overrides both ways",
      mk({
        holds: { recurring_routes: true, order_delivery: false, driver_payments: true },
        overrides: [
          ["recurring_routes", "GRANT"],
          ["order_delivery", "DENY"],
        ],
        rowHeld: new Set(["order_delivery"]),
      }),
    ],
    ["stored modes already set", mk({ modes: { fulfilment_model: "ship", counter_sales: "on" } })],
  ];

  it.each(LEGACY.flatMap((l) => STATES.map(([name, st]) => [l.key, name, l, st] as const)))(
    "%s from %s",
    (key, _name, legacy, state) => {
      const actual = planBusinessProfile(profile(key), state);
      const expected = legacyPlan(legacy, state);
      expect(actual.overrides).toEqual(expected.overrides);
      expect(actual.comps).toEqual(expected.comps);
      expect(actual.billing).toEqual(expected.billing);
      // the ONLY difference: the counter line the two presets without a counter now carry
      expect(actual.modes.filter((m) => !(m.key === "counter_sales" && m.to === "unset"))).toEqual(
        expected.modes,
      );
    },
  );
});
