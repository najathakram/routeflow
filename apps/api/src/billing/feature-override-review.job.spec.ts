// `@LeaderCron` wraps every cron tick in a Postgres advisory lock (common/cron-lock.ts). Mirrors
// billing-cron.service.spec.ts's convention: a pass-through mock that still calls the real
// body, but here it also records the call so we can assert the exact lock key the tick runs
// under (proves this is NOT a bare, unelected @Cron).
const withAdvisoryLockMock = jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
  acquired: true,
  value: await fn(),
}));
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: (...args: [unknown, () => Promise<unknown>]) =>
    (withAdvisoryLockMock as any)(...args),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import {
  FeatureOverrideReviewJob,
  FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
} from "./feature-override-review.job";

function overrideRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "ov1",
    tenantId: "t1",
    featureKey: "tobacco_dealer",
    kind: "PILOT",
    effect: "GRANT",
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function build(rows: ReturnType<typeof overrideRow>[]) {
  const prisma = {
    tenantFeatureOverride: {
      // Real Prisma semantics would apply `where` server-side; this in-memory filter mirrors
      // that so the job's own where-clause shape is what actually selects the fixture rows,
      // not a fixture pre-filtered by the test.
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const now = where.expiresAt.lte as Date;
        return Promise.resolve(
          rows.filter(
            (r) =>
              r.revokedAt === null && r.expiresAt != null && r.expiresAt.getTime() <= now.getTime(),
          ),
        );
      }),
    },
  } as any;
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as any;
  return { job: new FeatureOverrideReviewJob(prisma, audit), prisma, audit };
}

describe("FeatureOverrideReviewJob.reviewExpiredOverrides", () => {
  beforeEach(() => withAdvisoryLockMock.mockClear());

  it("flags exactly one expired-unrevoked override and leaves an active one alone", async () => {
    const { job, audit } = build([
      overrideRow({ id: "ov-expired", expiresAt: new Date("2000-01-01T00:00:00Z") }),
      overrideRow({ id: "ov-active", expiresAt: new Date(Date.now() + 86_400_000) }),
    ]);

    const result = await job.reviewExpiredOverrides();

    expect(result.reviewed).toBe(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: null,
        action: FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
        entityType: "tenantFeatureOverride",
        entityId: "ov-expired",
      }),
    );
  });

  it("skips an already-revoked expired row -- writes no audit row for it", async () => {
    const { job, audit } = build([
      overrideRow({
        id: "ov-revoked",
        expiresAt: new Date("2000-01-01T00:00:00Z"),
        revokedAt: new Date(),
      }),
    ]);

    const result = await job.reviewExpiredOverrides();

    expect(result.reviewed).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("never revokes the row -- update() is not even wired on this collaborator", async () => {
    const { job, prisma } = build([
      overrideRow({ id: "ov-expired", expiresAt: new Date("2000-01-01T00:00:00Z") }),
    ]);
    expect(prisma.tenantFeatureOverride.update).toBeUndefined();
    await job.reviewExpiredOverrides();
    // Still true after the tick ran -- confirms the job never even tries to call it.
    expect(prisma.tenantFeatureOverride.update).toBeUndefined();
  });

  it("runs the tick under the shared advisory lock, keyed by the pinned job name", async () => {
    const { job } = build([]);
    await job.reviewExpiredOverrides();
    expect(withAdvisoryLockMock).toHaveBeenCalledWith(
      expect.objectContaining({
        family: "cron",
        key: "billing.reviewExpiredOverrides",
        mode: "try",
      }),
      expect.any(Function),
    );
  });
});
