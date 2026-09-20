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
  // Emulates the query semantics the implementation relies on. Deliberately does NOT treat
  // "lte" as implicitly excluding NULL (real SQL does, but then `not: null` becomes unobservable):
  // a null expiresAt is excluded ONLY by an explicit `not: null`, so deleting it fails a test.
  const matches = (r: Row, where: any) => {
    if (where.id !== undefined && r.id !== where.id) return false;
    if (where.tenantId !== undefined && r.tenantId !== where.tenantId) return false;
    if (where.revokedAt !== undefined && r.revokedAt !== where.revokedAt) return false;
    const exp = where.expiresAt;
    if (exp !== undefined) {
      if (exp.not === null && r.expiresAt === null) return false;
      if (exp.lte !== undefined && r.expiresAt !== null && r.expiresAt > exp.lte) return false;
    }
    return true;
  };

  // Writes are only legal through the `tx` handed to a $transaction callback. Root-client writes
  // (`this.prisma.x.update` inside the callback) would autocommit outside the transaction in real
  // Prisma, so the fake refuses them — a refactor that drops `tx` can no longer pass this suite.
  const viaTx = { on: false };
  const assertViaTx = (what: string): void => {
    if (!viaTx.on) throw new Error(`${what} called outside the transaction client (B580)`);
  };
  const throughTx =
    <A, R>(fn: (a: A) => R) =>
    (a: A): R => {
      viaTx.on = true;
      try {
        return fn(a);
      } finally {
        viaTx.on = false;
      }
    };
  const tx = {
    tenantFeatureOverride: {
      update: throughTx((a: unknown) => prisma.tenantFeatureOverride.update(a)),
    },
    auditLog: { create: throughTx((a: unknown) => prisma.auditLog.create(a)) },
  };

  const prisma = {
    tenantFeatureOverride: {
      findMany: jest.fn().mockImplementation(({ where, take }: any) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, where))
            .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0))
            .slice(0, take ?? rows.length),
        ),
      ),
      update: jest.fn().mockImplementation(({ where, data }: any) => {
        assertViaTx("tenantFeatureOverride.update");
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
    // The sweep writes its audit row with `tx.auditLog.create` INSIDE each row's transaction
    // (B580); `audit.log` records every such write so the assertions below read the same.
    auditLog: {
      create: jest.fn().mockImplementation(({ data }: any) => {
        assertViaTx("auditLog.create");
        return audit.log(data);
      }),
    },
    // Emulates an interactive transaction with ROLLBACK: rows and audits are snapshotted and
    // restored when the callback throws — the property B580 depends on.
    $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const rowsBefore = rows.map((r) => ({ ...r }));
      const auditsBefore = audit.written.length;
      try {
        return await fn(tx);
      } catch (e) {
        rows.forEach((r, i) => Object.assign(r, rowsBefore[i]));
        audit.written.length = auditsBefore;
        throw e;
      }
    }),
  } as any;
  const audit = {
    written: [] as any[],
    log: jest.fn().mockImplementation(async (dto: any) => {
      audit.written.push(dto);
    }),
  } as any;
  const svc = new FeatureOverrideService(prisma);
  return { job: new FeatureOverrideExpiryJob(svc), svc, prisma, audit, rows };
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

  it("a human revoking between select and write is left alone: not overwritten, not audited", async () => {
    const human = new Date("2026-09-18T12:00:00Z");
    const { job, rows, prisma, audit } = build([overrideRow({ id: "ov-raced", expiresAt: PAST })]);
    // Select sees the row as due; a human then revokes it BEFORE the sweep's own write. The
    // write's `revokedAt: null` filter is what keeps the sweep from stamping over that revoke.
    const select = prisma.tenantFeatureOverride.findMany.getMockImplementation()!;
    prisma.tenantFeatureOverride.findMany.mockImplementationOnce(async (args: unknown) => {
      const due = await select(args);
      rows[0].revokedAt = human;
      return due;
    });

    await expect(job.revokeExpiredOverrides()).resolves.toEqual({ revoked: 0 });

    expect(rows[0].revokedAt).toBe(human);
    expect(audit.log).not.toHaveBeenCalled();
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

  it("leaves a row for the review job until it has been expired a full day (24h grace)", async () => {
    const now = Date.now();
    const { job, rows, audit } = build([
      overrideRow({ id: "ov-1h", expiresAt: new Date(now - 60 * 60 * 1000) }),
      overrideRow({ id: "ov-23h", expiresAt: new Date(now - 23 * 60 * 60 * 1000) }),
      overrideRow({ id: "ov-25h", expiresAt: new Date(now - 25 * 60 * 60 * 1000) }),
    ]);

    const result = await job.revokeExpiredOverrides();

    expect(result.revoked).toBe(1);
    expect(rows.find((r) => r.id === "ov-25h")!.revokedAt).toBeInstanceOf(Date);
    expect(rows.find((r) => r.id === "ov-1h")!.revokedAt).toBeNull();
    expect(rows.find((r) => r.id === "ov-23h")!.revokedAt).toBeNull();
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it("the service itself has no grace by default — revokeExpired() takes a row expired 1h ago", async () => {
    const { svc, rows } = build([
      overrideRow({ id: "ov-1h", expiresAt: new Date(Date.now() - 60 * 60 * 1000) }),
    ]);
    const revoked = await svc.revokeExpired();
    expect(revoked.map((r) => r.id)).toEqual(["ov-1h"]);
    expect(rows[0].revokedAt).toBeInstanceOf(Date);
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

  // ── B580: revoke + audit are ONE transaction per row ─────────────────────────
  describe("B580 — a DB error mid-batch never loses an audit row", () => {
    const expired = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        overrideRow({
          id: `ov${i + 1}`,
          featureKey: `key${i + 1}`,
          // distinct, ascending expiry so the sweep processes them in id order
          expiresAt: new Date(PAST.getTime() + i * 1000),
        }),
      );

    it("a write error on row 3 leaves rows 1-2 revoked AND audited, and rows 3-5 untouched", async () => {
      const { job, rows, audit, prisma } = build(expired(5));
      const real = prisma.tenantFeatureOverride.update.getMockImplementation()!;
      prisma.tenantFeatureOverride.update.mockImplementation((args: any) => {
        if (args.where.id === "ov3") throw new Error("connection reset");
        return real(args);
      });

      await expect(job.revokeExpiredOverrides()).rejects.toThrow("connection reset");

      expect(rows.filter((r) => r.revokedAt !== null).map((r) => r.id)).toEqual(["ov1", "ov2"]);
      // The regression: previously ZERO audit rows survived a throw at row 3.
      expect(audit.written.map((a: any) => a.entityId)).toEqual(["ov1", "ov2"]);
    });

    it("a failed AUDIT write rolls that row's revoke back with it — never revoked-but-unaudited", async () => {
      const { job, rows, audit } = build(expired(3));
      audit.log.mockImplementation(async (dto: any) => {
        if (dto.entityId === "ov2") throw new Error("audit insert failed");
        audit.written.push(dto);
      });

      await expect(job.revokeExpiredOverrides()).rejects.toThrow("audit insert failed");

      expect(rows.find((r) => r.id === "ov1")!.revokedAt).not.toBeNull();
      expect(rows.find((r) => r.id === "ov2")!.revokedAt).toBeNull(); // rolled back
      expect(audit.written.map((a: any) => a.entityId)).toEqual(["ov1"]);
    });

    it("the next sweep retries the row that failed, and audits every row exactly once overall", async () => {
      const { job, rows, audit, prisma } = build(expired(4));
      const real = prisma.tenantFeatureOverride.update.getMockImplementation()!;
      prisma.tenantFeatureOverride.update.mockImplementationOnce(real); // ov1 ok
      prisma.tenantFeatureOverride.update.mockImplementationOnce(() => {
        throw new Error("boom"); // ov2 fails
      });
      await expect(job.revokeExpiredOverrides()).rejects.toThrow("boom");

      prisma.tenantFeatureOverride.update.mockImplementation(real); // DB healthy again
      const second = await job.revokeExpiredOverrides();

      expect(second.revoked).toBe(3); // ov2, ov3, ov4 — ov1 was already done
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
      const ids = audit.written.map((a: any) => a.entityId).sort();
      expect(ids).toEqual(["ov1", "ov2", "ov3", "ov4"]); // each exactly once, none lost
    });
  });
});
