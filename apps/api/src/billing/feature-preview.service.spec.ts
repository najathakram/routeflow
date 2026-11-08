import { FeaturePreviewService } from "./feature-preview.service";
import { V11_PIN_FIXTURE, featureConfigOver, mockCollaborators } from "./feature-fixtures";

function buildPreview(
  fixture: typeof V11_PIN_FIXTURE,
  flagsOverride?: string[],
  stored: Record<string, string> = {},
) {
  const { entitlements, featureOverrides, catalog, prisma } = mockCollaborators(
    fixture,
    flagsOverride,
  );
  const featureConfig = featureConfigOver(stored);
  const preview = new FeaturePreviewService(
    entitlements as any,
    featureOverrides as any,
    catalog as any,
    prisma as any,
    featureConfig.service,
  );
  return { preview, featureOverrides, catalog, featureConfig };
}

// Oracle 6: preview == post-apply trace, 0 writes.
describe("FeaturePreviewService — oracle 6 (preview == post-apply trace, 0 writes)", () => {
  it("a hypothetical GRANT override changes only that key's `after.resolver`, and `changed` names exactly it", async () => {
    const { preview, featureOverrides } = buildPreview(V11_PIN_FIXTURE);

    const result = await preview.preview("t1", {
      overrides: [{ featureKey: "flag.estimates", effect: "GRANT", reason: "pilot" }],
    });

    const before = result.before.find((f) => f.key === "flag.estimates")!;
    const after = result.after.find((f) => f.key === "flag.estimates")!;
    expect(before.resolver).toBe(false); // dark, not held, resolver has no courtesy logic
    expect(after.resolver).toBe(true);
    expect(after.source).toBe("OVERRIDE_GRANT");
    expect(result.changed).toEqual(["flag.estimates"]);

    // Zero writes: the override store was only ever READ, never created/updated.
    expect(featureOverrides.get).not.toHaveBeenCalled();
    expect((featureOverrides as any).create).toBeUndefined();
  });

  it("matches what applying the SAME override for real would then resolve to", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE);
    const previewResult = await preview.preview("t1", {
      overrides: [{ featureKey: "flag.estimates", effect: "GRANT", reason: "pilot" }],
    });

    // Simulate "post-apply": the override is now actually active — same fixture, override applied.
    const postApplyFixture = {
      ...V11_PIN_FIXTURE,
      overrides: [{ featureKey: "flag.estimates" as const, effect: "GRANT" as const }],
    };
    const { preview: postApplyPreview } = buildPreview(postApplyFixture);
    const postApplyResult = await postApplyPreview.preview("t1", {});

    const previewAfter = previewResult.after.find((f) => f.key === "flag.estimates")!;
    const postApplyBefore = postApplyResult.before.find((f) => f.key === "flag.estimates")!;
    expect(previewAfter.resolver).toBe(postApplyBefore.resolver);
    expect(previewAfter.source).toBe(postApplyBefore.source);
  });

  it("a hypothetical plan downgrade shows losses without touching the real entitlements read", async () => {
    const { preview, featureOverrides } = buildPreview(V11_PIN_FIXTURE);
    const result = await preview.preview("t1", { planKey: "STARTER" });

    const beforeReports = result.before.find((f) => f.key === "flag.reports")!;
    const afterReports = result.after.find((f) => f.key === "flag.reports")!;
    expect(beforeReports.resolver).toBe(true); // SCALE's fixture featureFlags include flag.reports
    expect(afterReports.resolver).toBe(false); // STARTER's fixture featureFlags do not
    expect(result.changed).toContain("flag.reports");
    expect(featureOverrides.get).not.toHaveBeenCalled();
  });

  // Item 6 (Opus review of 9923b87c): preview == post-apply, covering an addon-granted flag
  // AND a plan swap together — the combination the two isolated tests above never exercise.
  // Addon-origin is real SKU/grantsFlags metadata (nit 3 of the 3585e1ec re-review), not a
  // flag stuffed into ent.flags via flagsOverride alone.
  it("preview == post-apply: an addon-granted flag survives a plan swap", async () => {
    const messagingAddonSkus = [
      {
        sku: "MSG_BUNDLE_500",
        name: "Messaging",
        monthlyPrice: "9.00",
        grantsFlags: ["flag.messaging"],
        meteredKey: null,
        capacityPerUnit: null,
      },
    ];
    // flag.messaging is bridged via an active addon SKU (NOT in SCALE's own featureFlags) —
    // exactly resolveOneKey's ADDON_SKU branch.
    const scaleWithAddonFlag = {
      ...V11_PIN_FIXTURE,
      name: "scale-with-addon-flag",
      activeSkuCodes: ["MSG_BUNDLE_500"],
    };
    const { preview, catalog } = buildPreview(scaleWithAddonFlag, [
      "flag.msrp",
      "flag.sales_agents",
      "flag.reports",
      "flag.returns",
      "flag.messaging",
    ]);
    (catalog.getVersionForTenant as jest.Mock).mockResolvedValue({
      id: scaleWithAddonFlag.planVersionId,
      definitions: scaleWithAddonFlag.definitions,
      addonSkus: messagingAddonSkus,
    });
    (catalog.getPublishedCatalog as jest.Mock).mockResolvedValue({
      id: scaleWithAddonFlag.planVersionId,
      definitions: scaleWithAddonFlag.definitions,
      addonSkus: messagingAddonSkus,
    });

    const previewResult = await preview.preview("t1", { planKey: "STARTER" }); // lacks flag.messaging too
    const previewAfterMessaging = previewResult.after.find((f) => f.key === "flag.messaging")!;
    expect(previewAfterMessaging.resolver).toBe(true);
    expect(previewAfterMessaging.source).toBe("ADDON_SKU");
    // Sanity: a flag genuinely lost by the swap (SCALE-included, STARTER-excluded, never
    // addon-bridged) really is lost — proves the addon isolation isn't "everything survives".
    const previewAfterReports = previewResult.after.find((f) => f.key === "flag.reports")!;
    expect(previewAfterReports.resolver).toBe(false);

    // "Post-apply": the tenant is now ACTUALLY on STARTER, still holding the same
    // addon-bridged flag — a real plan swap never touches addon grants.
    const postApplyFixture = {
      ...scaleWithAddonFlag,
      planKey: "STARTER",
      definitions: scaleWithAddonFlag.definitions,
    };
    const { preview: postApplyPreview, catalog: postApplyCatalog } = buildPreview(
      postApplyFixture,
      ["flag.msrp", "flag.messaging"],
    );
    (postApplyCatalog.getVersionForTenant as jest.Mock).mockResolvedValue({
      id: postApplyFixture.planVersionId,
      definitions: postApplyFixture.definitions,
      addonSkus: messagingAddonSkus,
    });
    (postApplyCatalog.getPublishedCatalog as jest.Mock).mockResolvedValue({
      id: postApplyFixture.planVersionId,
      definitions: postApplyFixture.definitions,
      addonSkus: messagingAddonSkus,
    });
    const postApplyResult = await postApplyPreview.preview("t1", {});
    const postApplyBeforeMessaging = postApplyResult.before.find(
      (f) => f.key === "flag.messaging",
    )!;

    expect(previewAfterMessaging.resolver).toBe(postApplyBeforeMessaging.resolver);
    expect(previewAfterMessaging.source).toBe(postApplyBeforeMessaging.source);
  });

  // Opus re-review of 3585e1ec, nit 3: a flag granted by BOTH the current plan's own
  // featureFlags AND an active addon's grantsFlags must survive a swap to a plan that
  // doesn't include it — the old `ent.flags minus currentDef.featureFlags` subtraction
  // silently excluded it, since "already in the current plan" looked indistinguishable
  // from "not addon-granted."
  it("keeps a flag granted by BOTH the current plan and an active addon across a plan swap", async () => {
    const fixtureWithDoubleCoveredFlag = {
      ...V11_PIN_FIXTURE,
      name: "scale-with-double-covered-flag",
      activeSkuCodes: ["FORECASTING_PACK"],
    };
    const { preview, catalog } = buildPreview(fixtureWithDoubleCoveredFlag);
    // flag.reports is already in SCALE's own featureFlags (V11_PIN_FIXTURE) — here it's ALSO
    // granted by an active addon SKU, the double-covered shape the fix targets.
    const addonSkus = [
      {
        sku: "FORECASTING_PACK",
        name: "Forecasting",
        monthlyPrice: "19.00",
        grantsFlags: ["flag.reports"],
        meteredKey: null,
        capacityPerUnit: null,
      },
    ];
    (catalog.getVersionForTenant as jest.Mock).mockResolvedValue({
      id: fixtureWithDoubleCoveredFlag.planVersionId,
      definitions: fixtureWithDoubleCoveredFlag.definitions,
      addonSkus,
    });
    (catalog.getPublishedCatalog as jest.Mock).mockResolvedValue({
      id: fixtureWithDoubleCoveredFlag.planVersionId,
      definitions: fixtureWithDoubleCoveredFlag.definitions,
      addonSkus,
    });

    const result = await preview.preview("t1", { planKey: "STARTER" }); // STARTER lacks flag.reports

    const afterReports = result.after.find((f) => f.key === "flag.reports")!;
    expect(afterReports.resolver).toBe(true); // survives via the addon grant, not the plan
    expect(afterReports.source).toBe("ADDON_SKU");
  });

  // Item 6(b): the target plan resolves against the CURRENT PUBLISHED catalog, never the
  // tenant's own (possibly stale) pinned version — a plan the pinned version doesn't even
  // carry must still preview correctly.
  it("resolves the swap target against the published catalog, not the tenant's pinned version", async () => {
    const { preview, catalog } = buildPreview(V11_PIN_FIXTURE);
    (catalog.getPublishedCatalog as jest.Mock).mockResolvedValue({
      id: "fixture-v12-published",
      definitions: [
        ...V11_PIN_FIXTURE.definitions,
        {
          planKey: "ENTERPRISE",
          featureFlags: ["flag.msrp", "flag.sales_agents", "flag.reports", "flag.analytics"],
        },
      ],
      addonSkus: [],
    });

    const result = await preview.preview("t1", { planKey: "ENTERPRISE" });

    const afterAnalytics = result.after.find((f) => f.key === "flag.analytics")!;
    expect(afterAnalytics.resolver).toBe(true); // only resolvable via the PUBLISHED catalog's def
    expect(afterAnalytics.detail.catalogVersionId).toBe("fixture-v12-published");
  });
});

// SA-1028 §5: the preview's mode state is the TENANT's state, read through the same
// `FeatureConfigService.getState` as the Feature Console row (B1132), on both sides.
describe("FeaturePreviewService - the stored mode (SA-1028 section 5)", () => {
  const modeOf = (side: Array<{ key: string; mode?: unknown }>, key: string) =>
    side.find((f) => f.key === key)?.mode as
      { value: string; effective: string; source: string; allowed: string[] } | undefined;

  it("P-R1: undoing a stored mode - before is the stored On, after is the requested unset", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE, undefined, { counter_sales: "on" });

    const result = await preview.preview("t1", { modes: { counter_sales: "unset" } });

    expect(modeOf(result.before, "counter_sales")).toMatchObject({ value: "on", source: "TENANT" });
    expect(modeOf(result.after, "counter_sales")).toMatchObject({
      value: "unset",
      effective: "unset",
      source: "TENANT",
    });
  });

  it("P-R1: the same for fulfilment_model (Not configured after a stored ship)", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE, undefined, { fulfilment_model: "ship" });

    const result = await preview.preview("t1", { modes: { fulfilment_model: "unset" } });

    expect(modeOf(result.before, "fulfilment_model")).toMatchObject({
      value: "ship",
      source: "TENANT",
    });
    expect(modeOf(result.after, "fulfilment_model")?.value).toBe("unset");
  });

  it("P-G1: a preview that requests no mode leaves every stored mode unchanged (after = before = stored)", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE, undefined, {
      fulfilment_model: "ship",
      counter_sales: "on",
    });

    const result = await preview.preview("t1", {
      overrides: [{ featureKey: "flag.estimates", effect: "GRANT", reason: "pilot" }],
    });

    for (const key of ["fulfilment_model", "counter_sales"]) {
      const before = modeOf(result.before, key);
      expect(before).toMatchObject({ source: "TENANT" });
      expect(modeOf(result.after, key)).toEqual(before);
    }
    expect(modeOf(result.before, "counter_sales")?.value).toBe("on");
  });

  it("P-G2: a key with no stored row reads the registry default (source REGISTRY_DEFAULT)", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE);

    const result = await preview.preview("t1", {});

    expect(modeOf(result.before, "counter_sales")).toMatchObject({
      value: "unset",
      source: "REGISTRY_DEFAULT",
    });
    expect(modeOf(result.after, "counter_sales")).toEqual(modeOf(result.before, "counter_sales"));
  });

  it("P-G3: requesting the mode already stored is no mode diff", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE, undefined, { counter_sales: "on" });

    const result = await preview.preview("t1", { modes: { counter_sales: "on" } });

    const before = modeOf(result.before, "counter_sales");
    const after = modeOf(result.after, "counter_sales");
    expect(after?.value).toBe(before?.value);
    expect(after?.effective).toBe(before?.effective);
  });

  it("oracle: the preview's after mode is what the console row reads once the mode is applied", async () => {
    const before = buildPreview(V11_PIN_FIXTURE, undefined, { counter_sales: "on" });
    const previewed = await before.preview.preview("t1", { modes: { counter_sales: "unset" } });

    // Post-apply: the row now holds the requested mode, and the console row reads it with getState.
    const applied = featureConfigOver({ counter_sales: "unset" });
    const row = await applied.service.getState("t1", "counter_sales");

    expect(modeOf(previewed.after, "counter_sales")).toEqual(row);
  });

  it("writes nothing: the stored mode is only read, and a key without a config block carries no mode", async () => {
    const { preview, featureConfig } = buildPreview(V11_PIN_FIXTURE, undefined, {
      counter_sales: "on",
    });

    const result = await preview.preview("t1", { modes: { counter_sales: "unset" } });

    expect(Object.keys(featureConfig.prisma.tenantFeatureConfig)).toEqual(["findUnique"]);
    expect(featureConfig.reads).toContain("counter_sales");
    expect(result.before.find((f) => f.key === "flag.estimates")?.mode).toBeUndefined();
  });
});

/**
 * FG-1 WP2 (R3, R5, SA-1099 sections 1, 4, 5). Courtesy is read PER SIDE: the "before" side takes the tenant's
 * plan, the "after" side takes the target plan (so Growth to Lite loses what the courtesy was serving, and
 * Growth to Starter does not). `serving` is what the guards serve; `resolver` is the strict answer;
 * `laterLost` names the keys that stay on for now but would go when the dark gate is enforced.
 *
 * The WP2 response fields are read through `WideResponse` so this block compiles against the old service and
 * fails there on the wrong VALUE.
 */
import type { FeaturePreviewResponse } from "@routeflow/types";
import { LITE_FIXTURE } from "./feature-fixtures";

type WideResponse = FeaturePreviewResponse & { laterLost?: string[]; omitted?: string[] };
const lostNow = (r: WideResponse) =>
  r.before
    .filter((b, i) => b.serving && !r.after[i].serving)
    .map((b) => b.key)
    .sort();

describe("WP2 preview: courtesy per side, laterLost, omissions", () => {
  const savedSwitch = process.env.PLAN_FLAG_ENFORCEMENT;
  beforeEach(() => {
    delete process.env.PLAN_FLAG_ENFORCEMENT;
  });
  afterAll(() => {
    if (savedSwitch === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
    else process.env.PLAN_FLAG_ENFORCEMENT = savedSwitch;
  });

  // Hand-worked from the v11 fixture (SCALE holds flag.sales_agents, flag.reports, flag.returns; STARTER holds
  // only flag.msrp) and the registry: flag.sales_agents and orders_inline_returns are enforced, so they are
  // lost now; flag.reports and flag.returns are dark flags, so the courtesy keeps them on after the move.
  it("T3: SCALE to STARTER loses the enforced rows now and lists the dark ones as stays-on-for-now", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE);
    const r = (await preview.preview("t1", { planKey: "STARTER" })) as WideResponse;
    expect(lostNow(r)).toEqual(["flag.sales_agents", "orders_inline_returns"]);
    expect([...(r.laterLost ?? [])].sort()).toEqual(["flag.reports", "flag.returns"]);
    expect([...r.changed].sort()).toEqual(
      ["flag.reports", "flag.returns", "flag.sales_agents", "orders_inline_returns"].sort(),
    );
    const reports = r.after.find((f) => f.key === "flag.reports")!;
    expect(reports).toMatchObject({ serving: true, resolver: false, source: "PRESET" });
    expect(reports.detail.term).toBe("courtesy");
  });

  it("T3: the preview equals the trace after the plan is really changed", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE);
    const previewed = await preview.preview("t1", { planKey: "STARTER" });
    // post-apply: the tenant now sits on STARTER, in the same catalog version
    const { preview: after } = buildPreview({ ...V11_PIN_FIXTURE, planKey: "STARTER" });
    const trace = await after.preview("t1", {});
    const shape = (f: (typeof trace.before)[number]) => ({
      key: f.key,
      serving: f.serving,
      resolver: f.resolver,
      source: f.source,
      term: f.detail.term,
    });
    expect(previewed.after.map(shape)).toEqual(trace.before.map(shape));
  });

  it("SA-1099 section 1: the credit check stays on across a move to STARTER while the switch is off", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE, [
      "flag.msrp",
      "flag.sales_agents",
      "flag.reports",
      "flag.returns",
      "flag.credit_limits",
    ]);
    const r = (await preview.preview("t1", { planKey: "STARTER" })) as WideResponse;
    expect(lostNow(r)).not.toContain("flag.credit_limits");
    expect(r.laterLost ?? []).toContain("flag.credit_limits");
  });

  it("with the switch ON the courtesy is gone: the dark rows are lost now and nothing is later", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const { preview } = buildPreview(V11_PIN_FIXTURE);
    const r = (await preview.preview("t1", { planKey: "STARTER" })) as WideResponse;
    expect(lostNow(r)).toEqual(
      ["flag.reports", "flag.returns", "flag.sales_agents", "orders_inline_returns"].sort(),
    );
    expect(r.laterLost).toEqual([]);
  });

  const GROWTH_WITH_LITE = {
    ...V11_PIN_FIXTURE,
    planKey: "GROWTH",
    definitions: [...V11_PIN_FIXTURE.definitions, { planKey: "LITE", featureFlags: [] }],
  };

  it("SA-1099 section 4: GROWTH to LITE loses what the courtesy was serving, now", async () => {
    const { preview } = buildPreview(GROWTH_WITH_LITE);
    const r = (await preview.preview("t1", { planKey: "LITE" })) as WideResponse;
    // GROWTH is served flag.reports by courtesy; LITE never is
    expect(lostNow(r)).toContain("flag.reports");
    expect(r.laterLost ?? []).not.toContain("flag.reports");
    expect(LITE_FIXTURE.planKey).toBe("LITE");
  });

  it("SA-1099 section 1: the credit check has no Lite exception, so a move to LITE leaves it unchanged", async () => {
    const { preview } = buildPreview(GROWTH_WITH_LITE);
    const r = (await preview.preview("t1", { planKey: "LITE" })) as WideResponse;
    expect(r.changed).not.toContain("flag.credit_limits");
    expect(r.after.find((f) => f.key === "flag.credit_limits")).toMatchObject({ serving: true });
  });

  it("a GRANT over a courtesy row changes the strict answer, so `changed` still names it", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE);
    const r = await preview.preview("t1", {
      overrides: [{ featureKey: "flag.estimates", effect: "GRANT", reason: "pilot" }],
    });
    expect(r.before.find((f) => f.key === "flag.estimates")).toMatchObject({
      serving: true,
      resolver: false,
    });
    expect(r.after.find((f) => f.key === "flag.estimates")).toMatchObject({
      serving: true,
      resolver: true,
    });
    expect(r.changed).toEqual(["flag.estimates"]);
  });

  it("T5: a plan move says what it leaves out; an override-only preview omits nothing", async () => {
    const { preview } = buildPreview(V11_PIN_FIXTURE);
    const move = (await preview.preview("t1", { planKey: "STARTER" })) as WideResponse;
    expect(move.omitted).toEqual(["limits", "price"]);
    const same = (await preview.preview("t1", {
      overrides: [{ featureKey: "flag.estimates", effect: "GRANT", reason: "pilot" }],
    })) as WideResponse;
    expect(same.omitted).toEqual([]);
  });

  it("SA-1099 section 5: preview and compute read add-on rows through one query", async () => {
    const { FeatureResolverService } = jest.requireActual("./feature-resolver.service");
    const { mockCollaborators } = jest.requireActual("./feature-fixtures");
    const c = mockCollaborators(V11_PIN_FIXTURE);
    const resolver = new FeatureResolverService(
      c.entitlements,
      c.featureOverrides,
      c.catalog,
      c.prisma,
    );
    await resolver.resolve("t1");
    const { preview } = buildPreview(V11_PIN_FIXTURE);
    // buildPreview owns its prisma mock, so re-wire a preview over `c`
    const p = new FeaturePreviewService(
      c.entitlements as any,
      c.featureOverrides as any,
      c.catalog as any,
      c.prisma as any,
      featureConfigOver({}).service,
    );
    await p.preview("t1", {});
    const calls = c.prisma.tenantAddon.findMany.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toEqual(calls[0][0]);
    expect(calls[0][0].select).toMatchObject({
      isComp: true,
      priceSnapshot: true,
      stripeItemId: true,
    });
    expect(preview).toBeDefined();
  });
});

describe("FG-1 WP4: a DENY over a billed key is named, never silently accepted", () => {
  function previewOver(rows: Record<string, unknown>[]) {
    const c = mockCollaborators(V11_PIN_FIXTURE);
    c.prisma.tenantAddon.findMany.mockResolvedValue(rows);
    return new FeaturePreviewService(
      c.entitlements as any,
      c.featureOverrides as any,
      c.catalog as any,
      c.prisma as any,
      featureConfigOver({}).service,
    );
  }
  const deny = { featureKey: "recurring_routes", effect: "DENY" as const, reason: "pilot over" };

  it("T7: a DENY over an active, priced row lists the key in stillBilled", async () => {
    const r = (await previewOver([
      {
        addonKey: "recurring_routes",
        sku: null,
        active: true,
        isComp: false,
        priceSnapshot: 25,
        stripeItemId: null,
      },
    ]).preview("t1", { overrides: [deny] })) as { stillBilled?: string[] };
    expect(r.stillBilled).toEqual(["recurring_routes"]);
  });

  it("T7 (one helper): a legacy sku-null row is billed for the flag its add-on key's SKU grants, as in I5", async () => {
    const c = mockCollaborators(V11_PIN_FIXTURE);
    c.prisma.tenantAddon.findMany.mockResolvedValue([
      {
        addonKey: "msrp",
        sku: null,
        active: true,
        isComp: false,
        priceSnapshot: 20,
        stripeItemId: null,
      },
    ]); // legacy map: msrp -> MSRP
    const published = await c.catalog.getPublishedCatalog();
    c.catalog.getPublishedCatalog.mockResolvedValue({
      ...published,
      addonSkus: [{ sku: "MSRP", grantsFlags: ["flag.msrp"] }],
    });
    const preview = new FeaturePreviewService(
      c.entitlements as any,
      c.featureOverrides as any,
      c.catalog as any,
      c.prisma as any,
      featureConfigOver({}).service,
    );
    const r = (await preview.preview("t1", {
      overrides: [{ featureKey: "flag.msrp", effect: "DENY", reason: "pilot over" }],
    })) as { stillBilled?: string[] };
    expect(r.stillBilled).toEqual(["flag.msrp"]);
  });

  it("T7: a key sent twice is named once", async () => {
    const r = (await previewOver([
      {
        addonKey: "recurring_routes",
        sku: null,
        active: true,
        isComp: false,
        priceSnapshot: 25,
        stripeItemId: null,
      },
    ]).preview("t1", { overrides: [deny, { ...deny }] })) as { stillBilled?: string[] };
    expect(r.stillBilled).toEqual(["recurring_routes"]);
  });

  it("T7: no warning for a comp row, a $0 row, a GRANT, or a key the request does not turn off", async () => {
    const comp = {
      addonKey: "recurring_routes",
      sku: null,
      active: true,
      isComp: true,
      priceSnapshot: 25,
      stripeItemId: null,
    };
    const free = { ...comp, isComp: false, priceSnapshot: 0 };
    const priced = { ...comp, isComp: false };
    expect(
      ((await previewOver([comp]).preview("t1", { overrides: [deny] })) as any).stillBilled,
    ).toBeUndefined();
    expect(
      ((await previewOver([free]).preview("t1", { overrides: [deny] })) as any).stillBilled,
    ).toBeUndefined();
    expect(
      (
        (await previewOver([priced]).preview("t1", {
          overrides: [{ ...deny, effect: "GRANT" }],
        })) as any
      ).stillBilled,
    ).toBeUndefined();
    expect(((await previewOver([priced]).preview("t1", {})) as any).stillBilled).toBeUndefined();
  });
});

/**
 * SA-1099 A-2 / SV-12: the preview's promise tied to the SHIPPED catalog, not the synthetic fixture.
 * Growth to Starter on `V11_DEFINITIONS` loses nothing now (0) and leaves exactly six rows on for now
 * (6): SA-1099 section 1's acceptance number. The count 6 comes from section 1; the six names come from
 * the run on 2026-11-05 against v11. A catalog change that legitimately moves this updates this row and
 * is an SA call. Red values: a seventh key, one of the six moving into `lostNow`, or the pre-WP2
 * resolver (which has no `laterLost` and shows the courtesy rows as lost).
 */
import type { FeatureFixture } from "./feature-fixtures";
import { V11_DEFINITIONS } from "../../prisma/plan-catalog-v11.definitions";

describe("SV-12: real v11 catalog, Growth to Starter", () => {
  const SIX = [
    "flag.analytics",
    "flag.reports",
    "flag.ap_bills",
    "flag.pricing_tiers",
    "addon.buyer_portal",
    "flag.credit_limits",
  ];
  const savedSwitch = process.env.PLAN_FLAG_ENFORCEMENT;
  beforeEach(() => {
    delete process.env.PLAN_FLAG_ENFORCEMENT;
  });
  afterEach(() => {
    if (savedSwitch === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
    else process.env.PLAN_FLAG_ENFORCEMENT = savedSwitch;
  });

  it("lostNow is [] and laterLost is exactly the six listed keys", async () => {
    const fixture: FeatureFixture = {
      name: "v11-real",
      planKey: "GROWTH",
      planVersionId: "real-v11",
      definitions: V11_DEFINITIONS.map((d) => ({
        planKey: d.planKey,
        featureFlags: [...d.featureFlags],
      })),
      activeAddonKeys: [],
      activeSkuCodes: [],
      overrides: [],
      usageKeys: [],
    };
    const c = mockCollaborators(fixture);
    const preview = new FeaturePreviewService(
      c.entitlements as any,
      c.featureOverrides as any,
      c.catalog as any,
      c.prisma as any,
      featureConfigOver().service,
    );
    const r = (await preview.preview("t1", { planKey: "STARTER" })) as WideResponse;
    expect(lostNow(r)).toEqual([]);
    expect([...(r.laterLost ?? [])].sort()).toEqual([...SIX].sort());
    expect(r.laterLost).toHaveLength(6);
  });
});
