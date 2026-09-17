import { EntitlementAuthority } from "./entitlement-authority.service";
import { FeatureResolverService } from "./feature-resolver.service";
import { FeatureDiffService } from "./feature-diff.service";
import { EntitlementsModeService } from "./entitlements-mode.service";
import { SubscriptionService } from "./subscription.service";
import { FEATURE_REGISTRY } from "./feature-registry";
import {
  V11_PIN_FIXTURE,
  LITE_FIXTURE,
  GRANT_OVERRIDE_FIXTURE,
  DENY_OVERRIDE_FIXTURE,
  mockCollaborators,
} from "./feature-fixtures";

/** Item 3 (Opus review of 9923b87c): the diff write is now fire-and-forget — its own
 *  `record()` call happens synchronously (so a spy sees it immediately), but the mocked
 *  Prisma calls INSIDE it are still promise-deferred, so a test that inspects the write's
 *  SIDE EFFECT (the diffRows map) must let that chain settle first. setImmediate runs after
 *  the current microtask queue drains, which is enough for record()'s handful of awaits. */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

/** Bare-bones PrismaService mock — only the shapes FeatureDiffService/EntitlementsModeService touch. */
function mockPrisma() {
  const diffRows = new Map<string, any>();
  return {
    featureResolverDiff: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        const key = JSON.stringify(where.tenantId_featureKey_before_after);
        return diffRows.get(key) ?? null;
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const key = JSON.stringify({
          tenantId: data.tenantId,
          featureKey: data.featureKey,
          before: data.before,
          after: data.after,
        });
        const row = { id: key, ...data, count: 1, lastSeenAt: new Date(), explainedAt: null };
        diffRows.set(key, row);
        return row;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        for (const [k, row] of diffRows) {
          if (row.id === where.id) {
            const updated = {
              ...row,
              ...data,
              count: (row.count ?? 1) + (data.count?.increment ?? 0),
            };
            diffRows.set(k, updated);
            return updated;
          }
        }
        throw new Error("not found");
      }),
      count: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.explainedAt === null) {
          return [...diffRows.values()].filter((r) => r.explainedAt === null).length;
        }
        return diffRows.size;
      }),
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        return [...diffRows.values()].filter((r) => {
          if (where?.tenantId && r.tenantId !== where.tenantId) return false;
          if (where?.explainedAt === null && r.explainedAt !== null) return false;
          return true;
        });
      }),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    __diffRows: diffRows,
  };
}

function buildAuthority(fixture: typeof V11_PIN_FIXTURE, flagsOverride?: string[]) {
  const {
    entitlements,
    featureOverrides,
    catalog,
    prisma: addonPrisma,
  } = mockCollaborators(fixture, flagsOverride);
  const resolver = new FeatureResolverService(
    entitlements as any,
    featureOverrides as any,
    catalog as any,
    addonPrisma as any,
  );
  const prisma = mockPrisma();
  const diffService = new FeatureDiffService(prisma as any);
  const modeService = new EntitlementsModeService(prisma as any);
  const authority = new EntitlementAuthority(
    entitlements as any,
    featureOverrides as any,
    resolver,
    modeService,
    diffService,
    addonPrisma as any,
  );
  return { authority, resolver, diffService, modeService, prisma };
}

describe("EntitlementAuthority — feature grants v2 brief A oracles", () => {
  // Oracle 1: shadow parity — every key × fixture, verdicts equal pre-PR.
  it("shadow mode: verdict for every registry key matches the old-path computation, for every fixture", async () => {
    for (const fixture of [V11_PIN_FIXTURE, LITE_FIXTURE]) {
      const { authority } = buildAuthority(fixture);
      for (const feature of FEATURE_REGISTRY) {
        const verdict = await authority.can("t1", feature.key);
        // Old-path parity for the flag-keyed half: matches allowsFlag's own semantics directly.
        if (feature.gate.via !== "RequireAddon" && feature.gate.via !== "guard") {
          const held = (
            fixture.definitions.find((d) => d.planKey === fixture.planKey)?.featureFlags ?? []
          ).includes(feature.key);
          const isDark = [
            "flag.analytics",
            "flag.forecasting",
            "flag.reports",
            "flag.returns",
            "flag.ap_bills",
            "flag.pricing_tiers",
            "flag.import_integrations",
            "flag.estimates",
            "flag.recurring_invoices",
            "flag.credit_notes",
            "flag.suppliers",
            "flag.messaging",
            "addon.buyer_portal",
          ].includes(feature.key);
          const expectCourtesy = isDark && fixture.planKey !== "LITE" && !held;
          expect(verdict).toBe(held || expectCourtesy);
        }
      }
    }
  });

  // Oracle 2: courtesy-on key absent from preset → diff (true,false); shadow still returns 200-equivalent (true).
  it("shadow mode: a dark flag the tenant doesn't hold produces a (true,false) diff but still courtesy-allows", async () => {
    const { authority, diffService, prisma } = buildAuthority(V11_PIN_FIXTURE);
    // flag.estimates is dark and NOT in V11_PIN_FIXTURE's SCALE featureFlags.
    const verdict = await authority.can("t1", "flag.estimates");
    expect(verdict).toBe(true); // old path still decides in shadow — no behavior change
    await flushMicrotasks(); // the diff write is fire-and-forget (item 3) — let it land
    const rows = [...prisma.__diffRows.values()];
    const row = rows.find((r) => r.featureKey === "flag.estimates");
    expect(row).toBeDefined();
    expect(row.before).toBe(true);
    expect(row.after).toBe(false);
  });

  // Oracle 3: live mode → 403 for it (i.e. authority.can() flips to false once live).
  it("live mode: the same courtesy-on key now resolves false (would 403 through the guard)", async () => {
    const { authority, modeService } = buildAuthority(V11_PIN_FIXTURE);
    await modeService.setMode("live");
    const verdict = await authority.can("t1", "flag.estimates");
    expect(verdict).toBe(false);
  });

  // Oracle 4 (service-level half — the 409/200 HTTP shape is the controller's job): mode=live is
  // refused while an unexplained diff exists, allowed once explained.
  it("hasUnexplained() reports true after a diff, false once every row is explained", async () => {
    const { authority, diffService } = buildAuthority(V11_PIN_FIXTURE);
    await authority.can("t1", "flag.estimates"); // produces one diff row
    await flushMicrotasks(); // the diff write is fire-and-forget (item 3) — let it land
    expect(await diffService.hasUnexplained()).toBe(true);

    const [row] = await diffService.list({ unexplainedOnly: true });
    await diffService.explain(row.id, "expected — catalog not yet re-pinned to v12");
    expect(await diffService.hasUnexplained()).toBe(false);
  });

  // Oracle 5: resolver DB error → verdict unchanged, no diff attempted.
  it("shadow mode: a resolver failure leaves the old-path verdict unchanged and records no diff", async () => {
    const { authority, resolver, prisma } = buildAuthority(V11_PIN_FIXTURE);
    jest.spyOn(resolver, "resolve").mockResolvedValue(null);
    const verdict = await authority.can("t1", "flag.estimates");
    expect(verdict).toBe(true); // same old-path courtesy-allow as the healthy-resolver case
    expect(prisma.__diffRows.size).toBe(0);
  });

  it("live mode: a resolver failure also falls back to the old-path verdict (fail-safe, same direction as today's guards)", async () => {
    const { authority, resolver, modeService } = buildAuthority(V11_PIN_FIXTURE);
    await modeService.setMode("live");
    jest.spyOn(resolver, "resolve").mockResolvedValue(null);
    const verdict = await authority.can("t1", "flag.estimates");
    expect(verdict).toBe(true);
  });

  // LITE always-enforced: no courtesy allow regardless of mode.
  it("LITE never gets the courtesy allow on a dark key it doesn't hold, shadow or live", async () => {
    const { authority, modeService } = buildAuthority(LITE_FIXTURE);
    expect(await authority.can("t1", "flag.estimates")).toBe(false);
    await modeService.setMode("live");
    expect(await authority.can("t1", "flag.estimates")).toBe(false);
  });

  // Item 3 (Opus review of 9923b87c): the fire-and-forget write is memoized — a second
  // disagreement for the identical (tenant, key, before, after) tuple within the TTL must
  // not re-invoke FeatureDiffService.record (only count/lastSeenAt churn would result, and
  // that's exactly the redundant-write traffic the memo exists to suppress).
  it("suppresses a repeat fire-and-forget diff write for the identical disagreement within the TTL", async () => {
    const { authority, diffService } = buildAuthority(V11_PIN_FIXTURE);
    const recordSpy = jest.spyOn(diffService, "record");
    await authority.can("t1", "flag.estimates");
    await authority.can("t1", "flag.estimates");
    await authority.can("t1", "flag.estimates");
    expect(recordSpy).toHaveBeenCalledTimes(1);
  });
});

// Item 7 (Opus review of 9923b87c): an authority oracle that sets PLAN_FLAG_ENFORCEMENT
// explicitly for both "on" and "off", proving the old path (what `served`/shadow-mode
// actually enforces) responds to the switch exactly like PlanFlagGuard always has.
describe("EntitlementAuthority — old path respects PLAN_FLAG_ENFORCEMENT explicitly, on and off", () => {
  const ORIGINAL_ENV = process.env;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  // flag.analytics is a DARK_PLAN_FLAGS member OUTSIDE PREPIN_DARK_FLAGS (the 5 P0 keys stay
  // dark unconditionally) — the only kind of key PLAN_FLAG_ENFORCEMENT actually gates.
  it('enforcement "on": a dark-rollout flag the tenant does not hold is denied (no courtesy allow)', async () => {
    process.env = { ...ORIGINAL_ENV, PLAN_FLAG_ENFORCEMENT: "on" };
    const { authority } = buildAuthority(V11_PIN_FIXTURE); // SCALE; featureFlags omit flag.analytics
    expect(await authority.can("t1", "flag.analytics")).toBe(false);
  });

  it('enforcement "off" (and unset): the same flag/tenant gets the courtesy allow', async () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PLAN_FLAG_ENFORCEMENT;
    const { authority } = buildAuthority(V11_PIN_FIXTURE);
    expect(await authority.can("t1", "flag.analytics")).toBe(true);

    process.env.PLAN_FLAG_ENFORCEMENT = "off";
    const { authority: authorityOff } = buildAuthority(V11_PIN_FIXTURE);
    expect(await authorityOff.can("t1", "flag.analytics")).toBe(true);
  });
});

// Item 2 (Opus review of 9923b87c): `served` must be byte-identical to
// `getSubscription().flags` — not just tested-equal to a hand-written expectation, but
// verified against a REAL SubscriptionService instance built from the SAME fixture, so a
// future change to either side that drifts them apart fails this oracle immediately.
describe("EntitlementAuthority.servedFlags() — parity oracle vs SubscriptionService.getSubscription().flags", () => {
  function buildSubscriptionService(fixture: typeof V11_PIN_FIXTURE) {
    const { entitlements, featureOverrides, catalog } = mockCollaborators(fixture);
    const prisma = {
      tenantSubscription: { findUnique: jest.fn().mockResolvedValue(null) },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const meters = {} as any;
    return new SubscriptionService(
      prisma as any,
      catalog as any,
      entitlements as any,
      meters,
      featureOverrides as any,
    );
  }

  it.each([
    ["v11-pin (SCALE)", V11_PIN_FIXTURE],
    ["LITE", LITE_FIXTURE],
    ["GRANT override", GRANT_OVERRIDE_FIXTURE],
    ["DENY override", DENY_OVERRIDE_FIXTURE],
  ])(
    "%s: EntitlementAuthority.servedFlags() matches getSubscription().flags key for key",
    async (_label, fixture) => {
      const { authority } = buildAuthority(fixture);
      const subscription = buildSubscriptionService(fixture);

      const served = await authority.servedFlags("t1");
      const subscriptionFlags = (await subscription.getSubscription("t1")).flags;

      expect(new Set(served)).toEqual(new Set(subscriptionFlags));
    },
  );
});
