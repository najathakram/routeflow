/**
 * SA-1099 A-3 note 2 and A-5 (F-WP5-1, rows S1..S4, S6, S7): `subscribe({ planKey, addons })` judges a NEW self-serve
 * add-on line against the TARGET plan, not the workspace's current one, before any Stripe call, lock or write. A SKU
 * the workspace already holds an active row for is a keep and is not judged (S6). `subscribe` changes the plan,
 * so the question is "does the plan this call lands on already serve it?".
 *
 * The target's effective answer comes from the REAL `FeaturePreviewService.preview(...)` (its `after` side, the one
 * preview home SV-12 pins), over the shared fixtures; only the data it reads is stubbed. A refusal throws BEFORE
 * `planTransition.prepare`, so "prepare never ran" is the proof that nothing reached Stripe, the lock or the ledger;
 * a sale that goes ahead is `prepare` running (it throws a sentinel here, which stops the call right after the check).
 */
import { ConflictException, BadRequestException, Logger } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { FeaturePreviewService } from "./feature-preview.service";
import { FeatureResolverService } from "./feature-resolver.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { featureConfigOver, mockCollaborators, type FeatureFixture } from "./feature-fixtures";

const FORECASTING = {
  sku: "FORECASTING",
  name: "Forecasting",
  monthlyPrice: 25,
  stackable: false,
  grantsFlags: ["flag.forecasting", "flag.analytics"],
  meteredKey: null,
  capacityPerUnit: null,
  includedAtPlan: null,
};
const PACK = {
  sku: "CUSTOMER_PACK_100",
  name: "Customer pack",
  monthlyPrice: 12,
  stackable: true,
  grantsFlags: [] as string[],
  meteredKey: "CUSTOMERS",
  capacityPerUnit: 100,
  includedAtPlan: null,
};
const ALREADY = {
  code: API_ERROR_CODES.ADDON_ALREADY_INCLUDED,
  message: "You already have Forecasting, so there is nothing to buy.",
};

const SENTINEL = new Error("REACHED_PREPARE: the add-on check let the sale through");

/** The tenant's catalog: LITE (always enforced, invite-only) and STARTER, neither carrying the Forecasting flags. */
function fixtureOn(planKey: "LITE" | "STARTER", pinnedVersionId = "fixture-v11"): FeatureFixture {
  return {
    name: `target-plan-${planKey}`,
    planKey,
    planVersionId: pinnedVersionId,
    definitions: [
      { planKey: "LITE", featureFlags: [] },
      { planKey: "STARTER", featureFlags: ["flag.msrp"] },
    ],
    activeAddonKeys: [],
    activeSkuCodes: [],
    overrides: [],
    usageKeys: [],
  };
}

function make(o: {
  from: "LITE" | "STARTER";
  skus?: any[];
  heldRow?: Record<string, unknown> | null;
  previewDown?: boolean;
  noPreview?: boolean;
  /** The workspace is pinned to an OLDER catalog version than the published one `subscribe` charges from. */
  pinnedOlder?: boolean;
}) {
  const c = mockCollaborators(fixtureOn(o.from, o.pinnedOlder ? "fixture-v10" : "fixture-v11"));
  const version = {
    id: "fixture-v11",
    definitions: [
      { planKey: "LITE", name: "Lite", featureFlags: [], isCustom: false, monthlyPrice: 0 },
      {
        planKey: "STARTER",
        name: "Starter",
        featureFlags: ["flag.msrp"],
        isCustom: false,
        monthlyPrice: 59,
      },
    ],
    addonSkus: o.skus ?? [FORECASTING, PACK],
  };
  c.catalog.getVersionForTenant.mockResolvedValue(
    o.pinnedOlder ? { ...version, id: "fixture-v10" } : version,
  );
  c.catalog.getPublishedCatalog.mockResolvedValue(version);
  c.catalog.getPublishedVersion.mockResolvedValue(version);

  const preview = new FeaturePreviewService(
    c.entitlements as any,
    c.featureOverrides as any,
    c.catalog as any,
    c.prisma as any,
    featureConfigOver().service,
  );
  if (o.previewDown) jest.spyOn(preview, "preview").mockRejectedValue(new Error("db down"));
  const previewSpy = jest.spyOn(preview, "preview");

  const prisma: any = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({
        status: "TRIAL",
        plan: o.from,
        class: "PRODUCTION",
        deletedAt: null,
        readOnlyReason: null,
      }),
    },
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
    tenantAddon: {
      findFirst: jest.fn(async () => o.heldRow ?? null),
      // `subscribe` reads "held" from its own prior-active read (SA-1099 A-5), no second query.
      findMany: jest.fn(async () => (o.heldRow ? [o.heldRow] : [])),
    },
    $transaction: jest.fn(),
  };
  const planTransition = { prepare: jest.fn().mockRejectedValue(SENTINEL) };
  const authority = {
    // The workspace's CURRENT answer, from the real resolver: what a wrong-plan reuse would have judged on.
    resolveAll: jest.fn((t: string) =>
      new FeatureResolverService(
        c.entitlements as any,
        c.featureOverrides as any,
        c.catalog as any,
        c.prisma as any,
      ).resolve(t),
    ),
    assertFeatureRequiresMet: jest.fn(async () => undefined),
    invalidate: jest.fn(),
  };
  const svc = new SubscriptionMutationService(
    prisma,
    c.catalog as any,
    { quote: jest.fn().mockResolvedValue({}) } as any,
    {} as any,
    c.entitlements as any,
    {} as any,
    {} as any,
    { isConfigured: false } as any,
    {} as any,
    planTransition as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    authority as any,
    o.noPreview ? undefined : (preview as any),
  );
  return { svc, prisma, planTransition, authority, previewSpy, publishedId: version.id };
}

const subscribe = (svc: SubscriptionMutationService, planKey: string, skus: string[]) =>
  svc.subscribe(
    "t1",
    { planKey, cycle: "MONTHLY", addons: skus.map((sku) => ({ sku, quantity: 1 })) } as any,
    "u1",
  );

async function outcome(p: Promise<unknown>) {
  try {
    await p;
    return { kind: "returned" as const };
  } catch (e) {
    return { kind: "threw" as const, error: e };
  }
}

describe("F-WP5-1: subscribe judges a self-serve add-on on the TARGET plan", () => {
  const saved = process.env.PLAN_FLAG_ENFORCEMENT;
  beforeEach(() => delete process.env.PLAN_FLAG_ENFORCEMENT);
  afterAll(() => {
    if (saved === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
    else process.env.PLAN_FLAG_ENFORCEMENT = saved;
  });

  it("S1: Starter, switch off: subscribe with FORECASTING is a 409, nothing prepared", async () => {
    const { svc, planTransition } = make({ from: "STARTER" });
    const r = await outcome(subscribe(svc, "STARTER", ["FORECASTING"]));
    expect(r.kind).toBe("threw");
    const err = (r as any).error;
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(expect.objectContaining(ALREADY));
    expect(planTransition.prepare).not.toHaveBeenCalled();
  });

  it("S3: Lite to Starter, switch off: judged on STARTER (courtesy serves it), so 409 - the current plan would sell", async () => {
    const { svc, planTransition, previewSpy } = make({ from: "LITE" });
    const r = await outcome(subscribe(svc, "STARTER", ["FORECASTING"]));
    expect(r.kind).toBe("threw");
    expect((r as any).error).toBeInstanceOf(ConflictException);
    expect((r as any).error.getResponse()).toEqual(expect.objectContaining(ALREADY));
    expect(planTransition.prepare).not.toHaveBeenCalled();
    expect(previewSpy).toHaveBeenCalledWith("t1", {
      planKey: "STARTER",
      versionId: "fixture-v11",
    });
  });

  it("S4: switch ON, Starter lacks both flags: no courtesy, so the sale goes ahead", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    const { svc, planTransition } = make({ from: "STARTER" });
    const r = await outcome(subscribe(svc, "STARTER", ["FORECASTING"]));
    expect((r as any).error).toBe(SENTINEL);
    expect(planTransition.prepare).toHaveBeenCalledTimes(1);
  });

  it("S2: Lite is invite-only, so Lite to Lite never reaches the add-on check (400 first, preview never read)", async () => {
    const { svc, planTransition, previewSpy } = make({ from: "LITE" });
    const r = await outcome(subscribe(svc, "LITE", ["FORECASTING"]));
    expect((r as any).error).toBeInstanceOf(BadRequestException);
    expect(planTransition.prepare).not.toHaveBeenCalled();
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it("controls that must still sell with the switch off: the capacity SKU, and a SKU the workspace already holds a row for", async () => {
    const pack = make({ from: "STARTER" });
    expect(
      ((await outcome(subscribe(pack.svc, "STARTER", ["CUSTOMER_PACK_100"]))) as any).error,
    ).toBe(SENTINEL);
    const held = make({
      from: "STARTER",
      heldRow: { addonKey: "FORECASTING", sku: "FORECASTING", active: true },
    });
    expect(((await outcome(subscribe(held.svc, "STARTER", ["FORECASTING"]))) as any).error).toBe(
      SENTINEL,
    );
  });

  it("no add-ons in the call: nothing is judged and the preview is never read", async () => {
    const { svc, previewSpy, planTransition } = make({ from: "STARTER" });
    const r = await outcome(subscribe(svc, "STARTER", []));
    expect((r as any).error).toBe(SENTINEL);
    expect(planTransition.prepare).toHaveBeenCalledTimes(1);
    expect(previewSpy).not.toHaveBeenCalled();
  });

  it("S7: the target plan bundles the SKU and the workspace holds no row: ADDON_INCLUDED_IN_PLAN, before anything is prepared", async () => {
    const bundled = { ...FORECASTING, includedAtPlan: "STARTER" };
    const { svc, planTransition } = make({ from: "LITE", skus: [bundled, PACK] });
    const r = await outcome(subscribe(svc, "STARTER", ["FORECASTING"]));
    expect((r as any).error).toBeInstanceOf(ConflictException);
    expect((r as any).error.getResponse()).toEqual(
      expect.objectContaining({ code: API_ERROR_CODES.ADDON_INCLUDED_IN_PLAN }),
    );
    expect(planTransition.prepare).not.toHaveBeenCalled();
  });

  it("S6 (SA-1099 A-5): the same bundled SKU with an ACTIVE row held is a keep - not judged, the existing reconcile runs", async () => {
    const bundled = { ...FORECASTING, includedAtPlan: "STARTER" };
    const { svc, planTransition, previewSpy, prisma } = make({
      from: "STARTER",
      skus: [bundled, PACK],
      heldRow: { addonKey: "FORECASTING", sku: "FORECASTING", active: true },
    });
    const r = await outcome(subscribe(svc, "STARTER", ["FORECASTING"]));
    expect((r as any).error).toBe(SENTINEL);
    expect(planTransition.prepare).toHaveBeenCalledTimes(1);
    expect(previewSpy).not.toHaveBeenCalled();
    // held is read from the method's own prior-active read: one findMany, no findFirst
    expect(prisma.tenantAddon.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.tenantAddon.findFirst).not.toHaveBeenCalled();
  });

  it("a preview that cannot answer never refuses on a guess: warns and the sale goes ahead", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      for (const opts of [{ previewDown: true }, { noPreview: true }]) {
        const { svc, planTransition } = make({ from: "STARTER", ...opts });
        const r = await outcome(subscribe(svc, "STARTER", ["FORECASTING"]));
        expect((r as any).error).toBe(SENTINEL);
        expect(planTransition.prepare).toHaveBeenCalledTimes(1);
      }
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not answer"));
    } finally {
      warn.mockRestore();
    }
  });

  it("S8 (SA-1099 A-7): the preview's after side judges the SAME PlanVersion id that subscribe charges with", async () => {
    // Pinned to v10 while v11 is published: subscribe prices from the published version, so the judgement must too,
    // for a same-plan pick and for a plan swap alike.
    for (const from of ["STARTER", "LITE"] as const) {
      const { svc, previewSpy, publishedId } = make({ from, pinnedOlder: true });
      await outcome(subscribe(svc, "STARTER", ["FORECASTING"]));
      const judged = await previewSpy.mock.results[0].value;
      const ids = new Set(judged.after.map((f: any) => f.detail.catalogVersionId));
      expect([...ids]).toEqual([publishedId]);
    }
  });
});
