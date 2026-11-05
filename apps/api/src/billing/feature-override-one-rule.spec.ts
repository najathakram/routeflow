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
  live("expired_then_live", "GRANT", new Date(Date.now() - DAY)), // expired: never supplies an effect
  live("expired_then_live", "DENY"),
  live("solo", "GRANT", new Date(Date.now() + DAY)),
];

function buildJob(otherRows: unknown[]) {
  const pilot = {
    id: "ov-pilot",
    tenantId: "t1",
    featureKey: "tobacco_dealer",
    kind: "PILOT",
    effect: "GRANT",
    revokedAt: null,
    expiresAt: new Date(Date.now() + 6 * DAY),
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
      findMany: jest.fn().mockImplementation(({ where }: any) =>
        // the per-business read of the OTHER overrides has a tenantId; the candidate page does not
        Promise.resolve(where?.tenantId ? otherRows : [pilot]),
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

  it("the job derives no effect from override rows on its own (the rule has one home)", () => {
    const src = fs.readFileSync(path.join(__dirname, "feature-override-review.job.ts"), "utf8");
    expect(src).not.toMatch(/otherOverrides\.set\(/);
  });
});
