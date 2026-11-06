import * as fs from "fs";
import * as path from "path";

// Capture what the job hands to billablePilotEnding as "the other live overrides" without deciding anything.
const billableSpy = jest.fn().mockReturnValue(null);
jest.mock("./billable-pilot-ending", () => ({
  ...jest.requireActual("./billable-pilot-ending"),
  billablePilotEnding: (...args: unknown[]) => billableSpy(...args),
}));
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { FeatureOverrideReviewJob } from "./feature-override-review.job";
import { FeatureOverrideService } from "./feature-override.service";

/**
 * B1282: "which override applies to a key" is ONE rule. The pilot-ending job decides whether a free period is paid from
 * the business's OTHER live overrides; the served answer (allActive) reads the same rows. They used to disagree on a
 * same-key tie (job last-wins, allActive first-wins). The partial unique index keeps that tie out of real data today, but
 * a relaxed index (stacked grants) must not make the owner email contradict what is served.
 */
const DAY = 86_400_000;
// A fixed collection-time anchor (not `Date.now() + N`, which the clock-fuse ratchet bans); every offset is a day or more.
const NOW = Date.now();
const live = (featureKey: string, effect: "GRANT" | "DENY", expiresAt: Date | null = null) => ({
  featureKey,
  effect,
  kind: "MANUAL",
  reason: null,
  expiresAt,
});

const OTHER_ROWS = [
  live("tie_key", "GRANT"), // a same-key tie: first row listed
  live("tie_key", "DENY"),
  live("expired_then_live", "GRANT", new Date(NOW - DAY)), // expired: never supplies an effect
  live("expired_then_live", "DENY"),
  live("solo", "GRANT", new Date(NOW + DAY)),
];

/** What the database does with an `orderBy` (a read with none keeps the physical order it was handed). */
function sortByOrder(rows: any[], orderBy?: Array<Record<string, "asc" | "desc">>): any[] {
  if (!orderBy) return rows;
  const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);
  return [...rows].sort((a, b) => {
    for (const o of orderBy) {
      const [key, dir] = Object.entries(o)[0];
      const av = val(a[key]);
      const bv = val(b[key]);
      if (av === bv || av === undefined || bv === undefined) continue;
      const c = (av as number) < (bv as number) ? -1 : 1;
      return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

function buildJob(otherRows: unknown[]) {
  const pilot = {
    id: "ov-pilot",
    tenantId: "t1",
    featureKey: "tobacco_dealer",
    kind: "PILOT",
    effect: "GRANT",
    revokedAt: null,
    expiresAt: new Date(NOW + 6 * DAY),
    tenant: {
      id: "t1",
      name: "Acme Foods",
      plan: "GROWTH",
      planVersionId: "v-1",
      deletedAt: null,
      class: "PRODUCTION",
      status: "ACTIVE",
      subscription: { planKey: "GROWTH" },
    },
  };
  const prisma = {
    tenantFeatureOverride: {
      findMany: jest.fn().mockImplementation(({ where, orderBy }: any) =>
        // the per-business read of the OTHER overrides has a tenantId; the candidate page does not
        Promise.resolve(where?.tenantId ? sortByOrder(otherRows as any[], orderBy) : [pilot]),
      ),
    },
    tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
  } as any;
  const catalog = { getVersionForTenant: jest.fn().mockResolvedValue({ addonSkus: [] }) } as any;
  const entitlements = {
    resolve: jest.fn().mockResolvedValue({ planKey: "GROWTH", flags: [] }),
  } as any;
  return new FeatureOverrideReviewJob(
    prisma,
    { log: jest.fn() } as any,
    { pilotEnding: jest.fn() } as any,
    catalog,
    entitlements,
  );
}

describe("B1282: the pilot-ending job and allActive() resolve a key from the same rule", () => {
  beforeEach(() => billableSpy.mockClear());

  it("fed the same rows, the job's other-overrides equal allActive() (first live row per key wins)", async () => {
    await buildJob(OTHER_ROWS).warnBillablePilotsEnding();
    expect(billableSpy).toHaveBeenCalledTimes(1);
    const jobView: Map<string, string> = billableSpy.mock.calls[0][0].otherOverrides;

    const prisma = { tenantFeatureOverride: { findMany: jest.fn().mockResolvedValue(OTHER_ROWS) } };
    const served = await new FeatureOverrideService(prisma as any).allActive("t1");

    expect(Object.fromEntries(jobView)).toEqual(Object.fromEntries(served));
    expect(served.get("tie_key")).toBe("GRANT");
    expect(served.get("expired_then_live")).toBe("DENY");
    expect(served.get("solo")).toBe("GRANT");
  });

  it("N-3: a same-key tie resolves the same whatever physical order the database holds the rows in (one read order)", async () => {
    const T0 = new Date(NOW - DAY); // identical createdAt: the id decides, and the rule says the higher id (id desc) is newest
    const tie = (id: string, effect: "GRANT" | "DENY") => ({
      ...live("tie_key", effect),
      id,
      createdAt: T0,
    });
    const physical = [
      [tie("ov-1", "GRANT"), tie("ov-2", "DENY")],
      [tie("ov-2", "DENY"), tie("ov-1", "GRANT")],
    ];
    for (const rows of physical) {
      billableSpy.mockClear();
      await buildJob(rows).warnBillablePilotsEnding();
      const jobView: Map<string, string> = billableSpy.mock.calls[0][0].otherOverrides;
      const prisma = {
        tenantFeatureOverride: {
          findMany: jest.fn(({ orderBy }: any) => Promise.resolve(sortByOrder(rows, orderBy))),
        },
      };
      const served = await new FeatureOverrideService(prisma as any).allActive("t1");
      expect(jobView.get("tie_key")).toBe("DENY");
      expect(served.get("tie_key")).toBe("DENY");
    }
  });

  it("the job derives no effect from override rows on its own (the rule has one home)", () => {
    const src = fs.readFileSync(path.join(__dirname, "feature-override-review.job.ts"), "utf8");
    expect(src).not.toMatch(/otherOverrides\.set\(/);
  });
});
