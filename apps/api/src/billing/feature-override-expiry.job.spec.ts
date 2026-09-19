// `@LeaderCron` wraps every tick in a Postgres advisory lock. Same pass-through mock as
// feature-override-review.job.spec.ts: still runs the real body, but records the call so the
// exact lock key can be asserted (proves this is NOT a bare, unelected @Cron).
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

import { Prisma } from "@prisma/client";
import { FeatureOverrideService } from "./feature-override.service";
import {
  EXPIRED_REVOKE_REASON,
  FEATURE_OVERRIDE_EXPIRY_REVOKED_ACTION,
  FeatureOverrideExpiryJob,
} from "./feature-override-expiry.job";

type Row = {
  id: string;
  tenantId: string;
  featureKey: string;
  kind: string;
  effect: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

const PAST = new Date("2000-01-01T00:00:00Z");
const FUTURE = new Date(Date.now() + 86_400_000);

function overrideRow(o: Partial<Row> = {}): Row {
  return {
    id: "ov1",
    tenantId: "t1",
    featureKey: "tobacco_dealer",
    kind: "PILOT",
    effect: "GRANT",
    expiresAt: null,
    revokedAt: null,
    ...o,
  };
}

/**
 * An in-memory tenantFeatureOverride table that APPLIES the queries' real `where` clauses, so
 * dropping `revokedAt: null`, the `lte`/`not: null` expiry predicate, or the take cap from the
 * implementation changes what comes back and fails the assertions instead of silently passing.
 */
function build(rows: Row[]) {
  const matches = (r: Row, where: any) =>
    (where.id === undefined || r.id === where.id) &&
    (where.tenantId === undefined || r.tenantId === where.tenantId) &&
    (where.revokedAt === undefined || r.revokedAt === where.revokedAt) &&
    (where.expiresAt === undefined ||
      (r.expiresAt != null &&
        (where.expiresAt.lte === undefined ||
          r.expiresAt.getTime() <= where.expiresAt.lte.getTime()) &&
        (where.expiresAt.not !== null || r.expiresAt !== null)));

  const prisma = {
    tenantFeatureOverride: {
      findMany: jest.fn().mockImplementation(({ where, take }: any) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, where))
            .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())
            .slice(0, take ?? rows.length),
        ),
      ),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        const r = rows.find((x) => matches(x, where));
        if (!r) {
          throw new Prisma.PrismaClientKnownRequestError("not found", {
            code: "P2025",
            clientVersion: "test",
          });
        }
        Object.assign(r, data);
        return Promise.resolve(r);
      }),
    },
  } as any;
  const svc = new FeatureOverrideService(prisma);
  const audit = { log: jest.fn().mockResolvedValue(undefined) } as any;
  return { job: new FeatureOverrideExpiryJob(svc, audit), svc, prisma, audit, rows };
}

describe("FeatureOverrideExpiryJob.revokeExpiredOverrides (B569)", () => {
  beforeEach(() => withAdvisoryLockMock.mockClear());

  it("revokes an expired row, audits it with reason 'expired', and leaves an active one alone", async () => {
    const { job, rows, audit } = build([
      overrideRow({ id: "ov-expired", expiresAt: PAST }),
      overrideRow({ id: "ov-active", expiresAt: FUTURE }),
    ]);

    const result = await job.revokeExpiredOverrides();

    expect(result.revoked).toBe(1);
    expect(rows.find((r) => r.id === "ov-expired")!.revokedAt).toBeInstanceOf(Date);
    expect(rows.find((r) => r.id === "ov-active")!.revokedAt).toBeNull();
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "t1",
        userId: null,
        action: FEATURE_OVERRIDE_EXPIRY_REVOKED_ACTION,
        entityType: "tenantFeatureOverride",
        entityId: "ov-expired",
        meta: expect.objectContaining({
          reason: EXPIRED_REVOKE_REASON,
          featureKey: "tobacco_dealer",
        }),
      }),
    );
  });

  it("NEVER touches a row without an expiresAt — a standing grant survives any number of sweeps", async () => {
    const { job, rows, audit, prisma } = build([
      overrideRow({ id: "ov-standing", expiresAt: null }),
    ]);

    await job.revokeExpiredOverrides();
    await job.revokeExpiredOverrides();

    expect(rows[0].revokedAt).toBeNull();
    expect(prisma.tenantFeatureOverride.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("is idempotent: a second run revokes nothing, audits nothing, and keeps the first revokedAt", async () => {
    const { job, rows, audit } = build([overrideRow({ id: "ov-expired", expiresAt: PAST })]);

    const first = await job.revokeExpiredOverrides();
    const stamped = rows[0].revokedAt;
    const second = await job.revokeExpiredOverrides();

    expect(first.revoked).toBe(1);
    expect(second.revoked).toBe(0);
    expect(rows[0].revokedAt).toBe(stamped);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it("skips an already-revoked expired row — no write, no audit", async () => {
    const already = new Date("2026-01-01T00:00:00Z");
    const { job, rows, audit, prisma } = build([
      overrideRow({ id: "ov-revoked", expiresAt: PAST, revokedAt: already }),
    ]);

    const result = await job.revokeExpiredOverrides();

    expect(result.revoked).toBe(0);
    expect(rows[0].revokedAt).toBe(already);
    expect(prisma.tenantFeatureOverride.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("a human revoking between select and write is skipped, not an error, and not audited", async () => {
    const { job, svc, prisma, audit } = build([overrideRow({ id: "ov-raced", expiresAt: PAST })]);
    // The row is selected as due, then gets revoked by a human before the sweep's own write.
    prisma.tenantFeatureOverride.update.mockImplementationOnce(() => {
      throw new Prisma.PrismaClientKnownRequestError("gone", {
        code: "P2025",
        clientVersion: "test",
      });
    });

    await expect(job.revokeExpiredOverrides()).resolves.toEqual({ revoked: 0 });
    expect(audit.log).not.toHaveBeenCalled();
    void svc;
  });

  it("revokes each tenant's own row (tenantId is in the write's where) and clears that tenant's cache", async () => {
    const { job, svc, prisma } = build([
      overrideRow({ id: "a", tenantId: "t1", expiresAt: PAST }),
      overrideRow({ id: "b", tenantId: "t2", expiresAt: PAST }),
    ]);
    const invalidate = jest.spyOn(svc, "invalidate");

    await job.revokeExpiredOverrides();

    expect(prisma.tenantFeatureOverride.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "a", tenantId: "t1", revokedAt: null }),
      }),
    );
    expect(invalidate.mock.calls.map((c) => c[0]).sort()).toEqual(["t1", "t2"]);
  });

  it("an audit-write failure does not abandon the rest of the batch", async () => {
    const { job, rows, audit } = build([
      overrideRow({ id: "first", expiresAt: new Date("2000-01-01T00:00:00Z") }),
      overrideRow({ id: "second", expiresAt: new Date("2000-01-02T00:00:00Z") }),
    ]);
    audit.log.mockRejectedValueOnce(new Error("audit down"));

    const result = await job.revokeExpiredOverrides();

    expect(result.revoked).toBe(2);
    expect(rows.every((r) => r.revokedAt instanceof Date)).toBe(true);
    expect(audit.log).toHaveBeenCalledTimes(2);
  });

  it("queries only revoked=null + expired rows, oldest first, capped at 500", async () => {
    const { job, prisma } = build([]);
    await job.revokeExpiredOverrides();
    expect(prisma.tenantFeatureOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revokedAt: null,
          expiresAt: { not: null, lte: expect.any(Date) },
        }),
        orderBy: { expiresAt: "asc" },
        take: 500,
      }),
    );
  });

  it("drains a backlog larger than one batch across ticks, oldest first", async () => {
    const many = Array.from({ length: 520 }, (_, i) =>
      overrideRow({ id: `ov${i}`, expiresAt: new Date(Date.UTC(2000, 0, 1, 0, 0, i)) }),
    );
    const { job, rows } = build(many);

    expect((await job.revokeExpiredOverrides()).revoked).toBe(500);
    expect(rows.filter((r) => r.revokedAt).length).toBe(500);
    expect(rows[519].revokedAt).toBeNull(); // newest of the backlog waits for the next tick
    expect((await job.revokeExpiredOverrides()).revoked).toBe(20);
  });

  it("is registered under a leader lock keyed billing.revokeExpiredOverrides (not a bare cron)", async () => {
    const { job } = build([]);
    await job.revokeExpiredOverrides();
    expect(withAdvisoryLockMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(withAdvisoryLockMock.mock.calls[0][0])).toContain(
      "billing.revokeExpiredOverrides",
    );
  });
});
