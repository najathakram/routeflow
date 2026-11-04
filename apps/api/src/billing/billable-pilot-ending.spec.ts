import { FEATURE_REGISTRY, featureDefByKey } from "./feature-registry";
import {
  billablePilotEnding,
  PILOT_WARNING_DAYS,
  type BillablePilotFacts,
} from "./billable-pilot-ending";

/**
 * SA-1100 §1: a pilot ending is "billable" only when all five parts hold. These rows go through the ONE
 * exported predicate the nightly job and this spec both import. BP-1..BP-4 are the ruling's red rows.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-11-04T12:00:00Z");
const OFF = {} as NodeJS.ProcessEnv; // PLAN_FLAG_ENFORCEMENT unset = the switch is off (dark)
const ON = { PLAN_FLAG_ENFORCEMENT: "on" } as NodeJS.ProcessEnv;

const REGULATED = {
  sku: "REGULATED_ITEMS",
  name: "Regulated items",
  monthlyPrice: "39.00",
  meteredKey: null as string | null,
  includedAtPlan: "SCALE" as string | null,
};
const FORECASTING = {
  sku: "FORECASTING",
  name: "Forecasting",
  monthlyPrice: "19.00",
  meteredKey: null as string | null,
  includedAtPlan: "SCALE" as string | null,
};
const CUSTOMER_PACK = {
  sku: "CUSTOMER_PACK_100",
  name: "Customer pack",
  monthlyPrice: "50.00",
  meteredKey: "CUSTOMERS",
  includedAtPlan: null as string | null,
};

function facts(over: Partial<BillablePilotFacts> = {}): BillablePilotFacts {
  return {
    override: {
      kind: "PILOT",
      effect: "GRANT",
      revokedAt: null,
      expiresAt: new Date(NOW.getTime() + 3 * DAY),
      featureKey: "tobacco_dealer",
    },
    now: NOW,
    tenant: { status: "ACTIVE", class: "PRODUCTION", deletedAt: null },
    planKey: "GROWTH",
    ent: { planKey: "GROWTH", flags: [] },
    otherOverrides: new Map(),
    addonRows: [],
    catalogSkus: [REGULATED, FORECASTING, CUSTOMER_PACK],
    ...over,
  };
}

describe("billablePilotEnding (SA-1100 §1)", () => {
  it("BP-2: a Regulated pilot on Growth with no add-on row is billable, priced from the pinned catalog", () => {
    expect(billablePilotEnding(facts(), OFF)).toEqual({
      sku: "REGULATED_ITEMS",
      name: "Regulated items",
      monthlyPrice: 39,
    });
  });

  it("BP-1: an analytics pilot on Starter with the switch off is NOT billable (the plan flag is served anyway)", () => {
    const f = facts({
      override: { ...facts().override, featureKey: "flag.analytics" },
      planKey: "STARTER",
      ent: { planKey: "STARTER", flags: [] },
    });
    expect(billablePilotEnding(f, OFF)).toBeNull();
  });

  it("the same analytics pilot becomes billable only when enforcement is on (the served answer then changes)", () => {
    const f = facts({
      override: { ...facts().override, featureKey: "flag.analytics" },
      planKey: "STARTER",
      ent: { planKey: "STARTER", flags: [] },
    });
    expect(billablePilotEnding(f, ON)).toEqual({
      sku: "FORECASTING",
      name: "Forecasting",
      monthlyPrice: 19,
    });
  });

  it.each([
    [
      "an active paid add-on row by sku",
      { addonKey: "other", sku: "REGULATED_ITEMS", active: true },
    ],
    ["an active add-on row by key", { addonKey: "tobacco_dealer", sku: null, active: true }],
  ])("BP-3: %s means the pilot ending changes nothing", (_l, row) => {
    expect(billablePilotEnding(facts({ addonRows: [row] }), OFF)).toBeNull();
  });

  it("an INACTIVE add-on row does not hold the SKU", () => {
    const rows = [{ addonKey: "tobacco_dealer", sku: "REGULATED_ITEMS", active: false }];
    expect(billablePilotEnding(facts({ addonRows: rows }), OFF)).not.toBeNull();
  });

  it.each(["TEST", "DEMO", "INTERNAL"])(
    "BP-4: a %s-class business never mails the owner",
    (cls) => {
      expect(
        billablePilotEnding(
          facts({ tenant: { status: "ACTIVE", class: cls, deletedAt: null } }),
          OFF,
        ),
      ).toBeNull();
    },
  );

  it.each(["TRIAL", "READ_ONLY", "SUSPENDED", "CANCELLED"])(
    "BP-5: a %s business (not ACTIVE) never mails the owner",
    (status) => {
      expect(
        billablePilotEnding(
          facts({ tenant: { status, class: "PRODUCTION", deletedAt: null } }),
          OFF,
        ),
      ).toBeNull();
    },
  );

  it("a deleted business never mails the owner", () => {
    const f = facts({ tenant: { status: "ACTIVE", class: "PRODUCTION", deletedAt: new Date() } });
    expect(billablePilotEnding(f, OFF)).toBeNull();
  });

  describe("rule 1: the override", () => {
    it("a TRIAL grant is a free period too", () => {
      const f = facts({ override: { ...facts().override, kind: "TRIAL" } });
      expect(billablePilotEnding(f, OFF)).not.toBeNull();
    });

    it.each([
      ["a comp", { kind: "COMP" }],
      ["a support grant", { kind: "SUPPORT" }],
      ["a grandfather grant", { kind: "GRANDFATHER" }],
      ["a deny", { effect: "DENY" }],
      ["revoked", { revokedAt: new Date() }],
      ["no end date", { expiresAt: null }],
      ["already ended", { expiresAt: new Date(NOW.getTime() - DAY) }],
      ["ending exactly now", { expiresAt: new Date(NOW.getTime()) }],
      ["ending in 8 days", { expiresAt: new Date(NOW.getTime() + 8 * DAY) }],
    ])("%s is not a billable ending", (_l, over) => {
      expect(
        billablePilotEnding(facts({ override: { ...facts().override, ...over } }), OFF),
      ).toBeNull();
    });

    it("ending exactly at the 7-day horizon still counts", () => {
      const f = facts({
        override: {
          ...facts().override,
          expiresAt: new Date(NOW.getTime() + PILOT_WARNING_DAYS * DAY),
        },
      });
      expect(billablePilotEnding(f, OFF)).not.toBeNull();
    });
  });

  describe("rule 2: ending it must change the served answer", () => {
    it("another live GRANT on the same key keeps it served, so nothing is lost", () => {
      const f = facts({ otherOverrides: new Map([["tobacco_dealer", "GRANT" as const]]) });
      expect(billablePilotEnding(f, OFF)).toBeNull();
    });

    it("the plan already carries the key (a flag served from the plan): nothing is lost", () => {
      const f = facts({
        override: { ...facts().override, featureKey: "flag.analytics" },
        ent: { planKey: "GROWTH", flags: ["flag.analytics"] },
      });
      expect(billablePilotEnding(f, ON)).toBeNull();
    });

    it("a key no guard checks (gate via none) has no served answer to lose, even with a flat paid SKU", () => {
      const f = facts({
        override: { ...facts().override, featureKey: "limit_customers" },
        catalogSkus: [{ ...CUSTOMER_PACK, meteredKey: null }],
      });
      expect(featureDefByKey("limit_customers")?.gate.via).toBe("none");
      expect(billablePilotEnding(f, OFF)).toBeNull();
    });

    it("an unresolvable plan (ent null) is never billable: fail closed, no mail", () => {
      expect(billablePilotEnding(facts({ ent: null }), OFF)).toBeNull();
    });
  });

  describe("rule 4: a flat, paid SKU in the pinned catalog that the plan does not include", () => {
    it.each([
      ["a SKU the catalog does not carry", { catalogSkus: [] }],
      ["a $0 SKU", { catalogSkus: [{ ...REGULATED, monthlyPrice: "0.00" }] }],
      ["a capacity SKU (metered)", { catalogSkus: [{ ...REGULATED, meteredKey: "CUSTOMERS" }] }],
      ["a SKU the plan includes", { catalogSkus: [{ ...REGULATED, includedAtPlan: "GROWTH" }] }],
      [
        "a SKU with an unparseable includedAtPlan",
        { catalogSkus: [{ ...REGULATED, includedAtPlan: "NOPE" }] },
      ],
    ])("%s is not billable", (_l, over) => {
      expect(billablePilotEnding(facts(over), OFF)).toBeNull();
    });

    it("a customer-pack pilot (capacity) is out until a capacity warning is built", () => {
      const f = facts({
        override: { ...facts().override, featureKey: "limit_customers" },
      });
      expect(billablePilotEnding(f, OFF)).toBeNull();
    });
  });

  it("a Regulated pilot on Scale (the plan includes it) is not billable", () => {
    const f = facts({ planKey: "SCALE", ent: { planKey: "SCALE", flags: [] } });
    expect(billablePilotEnding(f, OFF)).toBeNull();
  });

  describe("class pin", () => {
    it("no gated feature that carries a SKU is the credit check (whose served rule is not the courtesy allow)", () => {
      // The credit row has its own served rule (creditLimitCheckApplies). If it ever gains a SKU the
      // predicate needs that branch, so this goes red instead of silently reading it as a plan flag.
      const creditLike = FEATURE_REGISTRY.filter(
        (f) => f.gate.via === "service" && f.gate.envSwitched && f.billing.skus.length > 0,
      );
      expect(creditLike.map((f) => f.key)).toEqual([]);
    });

    it("the registry still ties Regulated items to the REGULATED_ITEMS SKU", () => {
      expect(featureDefByKey("tobacco_dealer")?.billing.skus).toEqual(["REGULATED_ITEMS"]);
    });
  });
});
