import { FEATURE_REGISTRY } from "./feature-registry";
import { resolveOneKey, ResolveContext } from "./feature-resolver.service";

/**
 * B508: the platform-admin tenant page used to carry legacy "MSRP on invoices" / "Sales agents
 * & commissions" toggle cards that wrote `TenantAddon{addonKey:"msrp"|"sales_agents"}`. Neither
 * key is ever read for enforcement — both features are actually gated by
 * `@RequirePlanFlag("flag.msrp"|"flag.sales_agents")`, resolved from the tenant's plan/override
 * flags, never from the addon table. The toggles were deleted (B508) because they were inert
 * and actively misleading; this pins that "inert" claim so a future change can't quietly wire
 * the addon table back in without a red test.
 */
describe("REG-B508: flag.msrp / flag.sales_agents resolve through the plan-flag path only", () => {
  const msrp = FEATURE_REGISTRY.find((f) => f.key === "flag.msrp")!;
  const salesAgents = FEATURE_REGISTRY.find((f) => f.key === "flag.sales_agents")!;

  it("both registry rows are RequirePlanFlag-gated, not addon-keyed", () => {
    expect(msrp.gate.via).toBe("RequirePlanFlag");
    expect(salesAgents.gate.via).toBe("RequirePlanFlag");
  });

  it("an active legacy 'msrp'/'sales_agents' TenantAddon row grants nothing — the addon table is never consulted for these keys", () => {
    // Simulates the orphaned rows B508 leaves behind: the legacy addonKey is "active", but
    // that is not the registry key ("flag.msrp"/"flag.sales_agents"), and no plan/override
    // flag is present either.
    const ctx: ResolveContext = {
      overrides: new Map(),
      activeAddonSet: new Set(["msrp", "sales_agents"]),
      planFeatureFlags: new Set(),
      entFlags: [],
      activeSkuSet: new Set(),
      courtesy: () => false,
      billed: new Set<string>(),
    };

    expect(resolveOneKey(msrp, ctx)).toMatchObject({ effective: false, source: "NONE" });
    expect(resolveOneKey(salesAgents, ctx)).toMatchObject({ effective: false, source: "NONE" });
  });

  it("only the dotted flag key (plan flags or an override) grants these features", () => {
    const grantedByPlan: ResolveContext = {
      overrides: new Map(),
      activeAddonSet: new Set(),
      planFeatureFlags: new Set(["flag.msrp", "flag.sales_agents"]),
      entFlags: ["flag.msrp", "flag.sales_agents"],
      activeSkuSet: new Set(),
      courtesy: () => false,
      billed: new Set<string>(),
    };
    expect(resolveOneKey(msrp, grantedByPlan)).toMatchObject({
      effective: true,
      source: "PRESET",
    });
    expect(resolveOneKey(salesAgents, grantedByPlan)).toMatchObject({
      effective: true,
      source: "PRESET",
    });

    const grantedByOverride: ResolveContext = {
      overrides: new Map([
        ["flag.msrp", "GRANT"],
        ["flag.sales_agents", "GRANT"],
      ]),
      activeAddonSet: new Set(),
      planFeatureFlags: new Set(),
      entFlags: [],
      activeSkuSet: new Set(),
      courtesy: () => false,
      billed: new Set<string>(),
    };
    expect(resolveOneKey(msrp, grantedByOverride)).toMatchObject({
      effective: true,
      source: "OVERRIDE_GRANT",
    });
    expect(resolveOneKey(salesAgents, grantedByOverride)).toMatchObject({
      effective: true,
      source: "OVERRIDE_GRANT",
    });
  });
});

/**
 * FG-1 WP2 (R1, R6): ONE evaluator returns `effective` (what is served) and `strict` (the owner's rule: plan
 * preset + purchased add-ons + grants - denies, no courtesy). The courtesy PREDICATE is `isCourtesyServed`
 * (its own spec); here it is a stub so each row pins how the evaluator COMBINES it, by hand.
 *
 * The WP2 context fields are passed through `withWp2` (untyped) so this block compiles against the old
 * resolver and fails there on the wrong VALUE, not on a type error.
 */
import { FeatureDef } from "./feature-registry";
import * as resolverModule from "./feature-resolver.service";

const def = (key: string): FeatureDef => FEATURE_REGISTRY.find((f) => f.key === key)!;
type Row = ReturnType<typeof resolveOneKey> & { strict?: boolean };

function withWp2(
  base: Partial<ResolveContext>,
  courtesy: (f: FeatureDef) => boolean,
  billed: string[] = [],
): ResolveContext {
  return {
    overrides: new Map(),
    activeAddonSet: new Set(),
    planFeatureFlags: new Set(),
    entFlags: [],
    activeSkuSet: new Set(),
    ...base,
    courtesy,
    billed: new Set(billed),
  } as ResolveContext;
}
const run = (key: string, ctx: ResolveContext): Row => resolveOneKey(def(key), ctx) as Row;

describe("T1 (R1): effective and strict, per hand table (owner's rule 2026-09-17)", () => {
  const yes = () => true;
  const no = () => false;

  it("plan holds the flag: served and strict, whatever the predicate says", () => {
    const ctx = withWp2(
      { planFeatureFlags: new Set(["flag.reports"]), entFlags: ["flag.reports"] },
      yes,
    );
    expect(run("flag.reports", ctx)).toMatchObject({
      effective: true,
      strict: true,
      source: "PRESET",
      term: "flag",
    });
  });

  it("dark flag the plan lacks, courtesy on: served but NOT strict, said so", () => {
    expect(run("flag.reports", withWp2({}, yes))).toMatchObject({
      effective: true,
      strict: false,
      source: "PRESET",
      term: "courtesy",
      charged: false,
    });
  });

  it("flag the plan lacks, no courtesy: neither", () => {
    expect(run("flag.reports", withWp2({}, no))).toMatchObject({
      effective: false,
      strict: false,
      source: "NONE",
    });
  });

  it("add-on key with no row, courtesy on: served, not strict", () => {
    expect(run("ocr", withWp2({}, yes))).toMatchObject({
      effective: true,
      strict: false,
      source: "PRESET",
      term: "courtesy",
    });
  });

  it("add-on key with a row: served and strict (comp or paid)", () => {
    expect(run("ocr", withWp2({ activeAddonSet: new Set(["ocr"]) }, yes))).toMatchObject({
      effective: true,
      strict: true,
      source: "PRESET",
      term: "includedSku",
    });
  });

  it("GRANT is served and strict; courtesy is not consulted", () => {
    const courtesy = jest.fn(() => true);
    const ctx = withWp2({ overrides: new Map([["flag.reports", "GRANT"]]) }, courtesy);
    expect(run("flag.reports", ctx)).toMatchObject({
      effective: true,
      strict: true,
      source: "OVERRIDE_GRANT",
    });
    expect(courtesy).not.toHaveBeenCalled();
  });

  it("DENY refuses both, even where the predicate says courtesy would serve (DENY wins)", () => {
    const ctx = withWp2({ overrides: new Map([["flag.reports", "DENY"]]) }, no);
    expect(run("flag.reports", ctx)).toMatchObject({
      effective: false,
      strict: false,
      source: "OVERRIDE_DENY",
    });
  });

  it("credit check under DENY while the switch is off: the guard still runs it, so it is served; the DENY stays visible", () => {
    // SA-1099 section 1: the third courtesy clause ignores overrides (the guard does too).
    const ctx = withWp2({ overrides: new Map([["flag.credit_limits", "DENY"]]) }, yes);
    expect(run("flag.credit_limits", ctx)).toMatchObject({
      effective: true,
      strict: false,
      source: "OVERRIDE_DENY",
    });
  });

  it("courtesy is asked only when the strict answer is no, and with the registry row", () => {
    const courtesy = jest.fn(() => true);
    run(
      "flag.reports",
      withWp2(
        { planFeatureFlags: new Set(["flag.reports"]), entFlags: ["flag.reports"] },
        courtesy,
      ),
    );
    expect(courtesy).not.toHaveBeenCalled();
    run("flag.reports", withWp2({}, courtesy));
    expect(courtesy).toHaveBeenCalledWith(def("flag.reports"));
  });

  it("property: strict implies effective, except under DENY where strict is false", () => {
    const bad: string[] = [];
    for (const feature of FEATURE_REGISTRY) {
      for (const override of [undefined, "GRANT", "DENY"] as const) {
        for (const courtesy of [yes, no]) {
          for (const held of [false, true]) {
            const r = run(
              feature.key,
              withWp2(
                {
                  overrides: new Map(override ? [[feature.key, override]] : []),
                  activeAddonSet: new Set(held ? [feature.key] : []),
                },
                courtesy,
              ),
            );
            if (r.strict === undefined) bad.push(`${feature.key}: no strict`);
            else if (r.strict && !r.effective) bad.push(`${feature.key}: strict without effective`);
            else if (override === "DENY" && r.strict) bad.push(`${feature.key}: strict under DENY`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("T6 (R6): charged is the billing fact of the row, under any override", () => {
  const isBilled = (resolverModule as unknown as Record<string, unknown>).isBilledAddonRow as
    ((row: Record<string, unknown>) => boolean) | undefined;
  const row = (over: Record<string, unknown>) => ({
    addonKey: "ocr",
    active: true,
    isComp: false,
    priceSnapshot: "12.00",
    stripeItemId: null,
    ...over,
  });

  it.each([
    ["priced, no Stripe item", row({}), true],
    ["priced, Stripe item", row({ stripeItemId: "si_1" }), true],
    ["$0 with a Stripe item", row({ priceSnapshot: "0.00", stripeItemId: "si_1" }), true],
    ["comp, priced", row({ isComp: true }), false],
    ["comp, Stripe item", row({ isComp: true, stripeItemId: "si_1" }), false],
    ["$0, no Stripe item", row({ priceSnapshot: "0.00" }), false],
    ["no price, no Stripe item", row({ priceSnapshot: null }), false],
    ["inactive, priced", row({ active: false }), false],
    ["a Decimal-like price", row({ priceSnapshot: { valueOf: () => "5.00" } }), true],
  ])("isBilledAddonRow: %s -> %s", (_name, r, expected) => {
    expect(typeof isBilled).toBe("function");
    expect(isBilled!(r)).toBe(expected);
  });

  const cases: Array<[string, string[], "GRANT" | "DENY" | undefined, boolean]> = [
    ["billed row, no override", ["ocr"], undefined, true],
    ["billed row, GRANT", ["ocr"], "GRANT", true],
    ["billed row, DENY (still being charged)", ["ocr"], "DENY", true],
    ["no billed row, no override", [], undefined, false],
    ["no billed row, GRANT", [], "GRANT", false],
    ["comp row (not in the billed set), SKU-granted", [], undefined, false],
  ];
  it.each(cases)("resolveOneKey: %s", (_name, billed, override, expected) => {
    const ctx = withWp2(
      {
        overrides: new Map(override ? [["ocr", override]] : []),
        activeAddonSet: new Set(["ocr"]),
        activeSkuSet: new Set(def("ocr").billing.skus),
      },
      () => false,
      billed,
    );
    expect(run("ocr", ctx).charged).toBe(expected);
  });
});

describe("T6 (R6) + courtesy through the service: compute() and preview share one loader", () => {
  const { FeatureResolverService } = resolverModule;
  const { V11_PIN_FIXTURE, mockCollaborators } = jest.requireActual("./feature-fixtures");
  const savedSwitch = process.env.PLAN_FLAG_ENFORCEMENT;
  beforeEach(() => {
    delete process.env.PLAN_FLAG_ENFORCEMENT;
  });
  afterAll(() => {
    if (savedSwitch === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
    else process.env.PLAN_FLAG_ENFORCEMENT = savedSwitch;
  });

  function build(rows: Array<Record<string, unknown>>, fixture = V11_PIN_FIXTURE) {
    const { entitlements, featureOverrides, catalog, prisma } = mockCollaborators(fixture);
    prisma.tenantAddon.findMany.mockResolvedValue(rows);
    const service = new FeatureResolverService(
      entitlements as never,
      featureOverrides as never,
      catalog as never,
      prisma as never,
    );
    return { service, prisma };
  }
  const billedRow = (addonKey: string, over: Record<string, unknown> = {}) => ({
    addonKey,
    active: true,
    isComp: false,
    priceSnapshot: "9.00",
    stripeItemId: "si_test_1",
    ...over,
  });

  it("a billed row is charged; a comp row on the same key is not (E12)", async () => {
    const billed = await build([billedRow("ocr")]).service.resolve("t1");
    expect(billed!.byKey.get("ocr")).toMatchObject({ charged: true });
    const comp = await build([billedRow("ocr", { isComp: true })]).service.resolve("t1");
    expect(comp!.byKey.get("ocr")).toMatchObject({ charged: false });
  });

  it("a GRANT over a billed row stays charged (E11)", async () => {
    const fixture = { ...V11_PIN_FIXTURE, overrides: [{ featureKey: "ocr", effect: "GRANT" }] };
    const r = await build([billedRow("ocr")], fixture).service.resolve("t1");
    expect(r!.byKey.get("ocr")).toMatchObject({ source: "OVERRIDE_GRANT", charged: true });
  });

  it("asks for the billing columns, in the one query the preview also uses", async () => {
    const { service, prisma } = build([billedRow("ocr")]);
    await service.resolve("t1");
    const select = prisma.tenantAddon.findMany.mock.calls[0][0].select;
    expect(select).toMatchObject({
      addonKey: true,
      active: true,
      isComp: true,
      priceSnapshot: true,
      stripeItemId: true,
    });
  });

  it("courtesy reaches the tenant's resolved keys: a dark flag the SCALE plan lacks is served, not strict", async () => {
    const r = await build([]).service.resolve("t1");
    // flag.estimates is dark and not in the v11 SCALE fixture's flags
    expect(r!.byKey.get("flag.estimates")).toMatchObject({
      effective: true,
      strict: false,
      source: "PRESET",
      term: "courtesy",
    });
    // a flag the plan holds is both
    expect(r!.byKey.get("flag.reports")).toMatchObject({ effective: true, strict: true });
  });

  it("a Lite tenant gets no courtesy", async () => {
    const { LITE_FIXTURE } = jest.requireActual("./feature-fixtures");
    const r = await build([], LITE_FIXTURE).service.resolve("t1");
    expect(r!.byKey.get("flag.estimates")).toMatchObject({ effective: false, strict: false });
    expect(r!.byKey.get("ocr")).toMatchObject({ effective: false, strict: false });
  });
});

describe("pinnedOverPublishedGrants: the one grants map I5 and the preview share", () => {
  it("the pinned entry wins where the catalogs disagree; the published one fills a code the pin lacks", () => {
    const m = resolverModule.pinnedOverPublishedGrants(
      [
        { sku: "A", grantsFlags: ["flag.a"] },
        { sku: "B", grantsFlags: ["flag.b"] },
      ],
      [{ sku: "A", grantsFlags: [] }],
    );
    expect(m.get("A")).toEqual([]);
    expect(m.get("B")).toEqual(["flag.b"]);
  });
});
