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

// pre-merge review (2026-09-17), MUST-4: the mock applies the job's ACTUAL `where` clause --
// not a hardcoded assumption baked into the fixture filter -- so dropping `revokedAt: null` (or
// `expiresAt.lte`) from the real query changes what this mock returns, and the assertions below
// fail instead of silently passing.
function build(rows: ReturnType<typeof overrideRow>[], auditedIds: string[] = []) {
  const prisma = {
    tenantFeatureOverride: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const lte = where?.expiresAt?.lte as Date | undefined;
        return Promise.resolve(
          rows.filter(
            (r) =>
              r.revokedAt === where?.revokedAt &&
              r.expiresAt != null &&
              lte != null &&
              (r.expiresAt as Date).getTime() <= lte.getTime(),
          ),
        );
      }),
    },
    auditLog: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const ids: string[] = where?.entityId?.in ?? [];
        return Promise.resolve(
          ids.filter((id) => auditedIds.includes(id)).map((entityId) => ({ entityId })),
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

  it("queries with revokedAt: null, expiresAt.lte <= now, oldest first, capped at 500", async () => {
    const { job, prisma } = build([]);
    await job.reviewExpiredOverrides();
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null, expiresAt: { lte: expect.any(Date) } }),
        orderBy: { expiresAt: "asc" },
        take: 500,
      }),
    );
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

  // pre-merge review, SHOULD-3: audit once EVER, not once per night.
  it("skips a row that already carries a FEATURE_OVERRIDE_EXPIRED_REVIEW audit row from a prior tick", async () => {
    const { job, audit, prisma } = build(
      [overrideRow({ id: "ov-already-flagged", expiresAt: new Date("2000-01-01T00:00:00Z") })],
      ["ov-already-flagged"],
    );

    const result = await job.reviewExpiredOverrides();

    expect(result.reviewed).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
          entityType: "tenantFeatureOverride",
          entityId: { in: ["ov-already-flagged"] },
        }),
      }),
    );
  });

  it("audits a not-yet-flagged row while skipping an already-flagged one in the SAME tick", async () => {
    const { job, audit } = build(
      [
        overrideRow({ id: "ov-new", expiresAt: new Date("2000-01-01T00:00:00Z") }),
        overrideRow({ id: "ov-old-flagged", expiresAt: new Date("1999-01-01T00:00:00Z") }),
      ],
      ["ov-old-flagged"],
    );

    const result = await job.reviewExpiredOverrides();

    expect(result.reviewed).toBe(1);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ entityId: "ov-new" }));
  });

  it("skips the auditLog dedupe query entirely when there is nothing expired", async () => {
    const { job, prisma } = build([]);
    await job.reviewExpiredOverrides();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
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
