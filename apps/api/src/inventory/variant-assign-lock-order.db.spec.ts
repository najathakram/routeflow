/**
 * SA-584 B1 (#2717 M2 fold) - real-Postgres proof that `assignToVariants` (mode `on`) takes the
 * FAMILY row F `FOR UPDATE` before it inserts the parent StockMovement (whose FK takes FOR KEY
 * SHARE on F), so a family price edit cannot deadlock against it (house order: family -> recipe
 * product -> variant rows).
 *
 * FORCED INTERLEAVE (the lead's B1 review, #2554 5885920100, and F2's finding that the old pin was
 * non-discriminating: the parent StockMovement insert's FK KEY SHARE on F conflicts with a FOR
 * UPDATE writer, so the old order blocked on F before ever touching V and the spec stayed green
 * against the bug). Per round, on fresh fixtures:
 *   1. the SERVICE goes FIRST: assignToVariants [existing V, new W] runs until it reaches the
 *      new-variant step, where a jest spy on `createVariantRowInTx` PAUSES it on a gate. That is
 *      AFTER the parent StockMovement insert (so it holds KEY SHARE on F, or with the fix the F FOR
 *      UPDATE lock) and AFTER the existing-V write, and BEFORE `familyPricesForNewVariant`'s
 *      F FOR UPDATE;
 *   2. the WRITER (raw pg) then issues `SELECT ... FOR UPDATE` on F and blocks behind the service;
 *      a BARRIER polls `pg_blocking_pids(writerPid)` until it names a backend, so the queue is real;
 *   3. RELEASE the gate; the service continues into its F FOR UPDATE.
 * Hazard without the lock (the revert): the service holds only KEY SHARE on F while the writer is
 * queued for FOR UPDATE, then the service wants FOR UPDATE on F itself: a KEY SHARE -> FOR UPDATE
 * upgrade behind a queued conflicting waiter = a 40P01 (F2 saw the SERVICE as the victim every
 * round). Fixed: the service already holds F FOR UPDATE from the start, so the writer simply waits,
 * the service commits, then the writer takes F, propagates the price to V and W, and commits; no
 * deadlock and both rows end with the edited tier price.
 *
 * RETRY INSTRUMENTATION (SA-587e): retryOnTxConflict absorbs a 40P01 (it retries it like a 40001),
 * so the revert does not always surface as a service error. The spec records the SQLSTATE of every
 * retried attempt (common/testing/tx-retry-capture.ts spies Logger.prototype.warn) and asserts ZERO
 * 40P01 each of 3 rounds; the reverted order forces the cycle every round.
 *
 * WRITTEN, NOT RUN by the fold implementer: F2 owns the DB lane (`npm run local:test:db`).
 * Throwaway `qa-2717-b1-<run>` tenant (assertTestTenant).
 */
import { randomUUID } from "crypto";
import { Test, TestingModule } from "@nestjs/testing";
import { Pool } from "pg";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { captureRetriedStates } from "../common/testing/tx-retry-capture";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

function sqlState(err: any): string | undefined {
  return (
    err?.meta?.driverAdapterError?.cause?.originalCode ?? err?.cause?.originalCode ?? err?.code
  );
}
const describeErr = (err: unknown): string =>
  err === undefined ? "none" : `${sqlState(err) ?? "?"}: ${String((err as any)?.message ?? err)}`;

describeDb("SA-584 B1 — assignToVariants takes the family row first (no 40P01)", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: InventoryService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2717-b1-${run}`, "variant-assign-lock-order.db.spec.ts");
  let tenantId = "";
  let userId = "";

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("on") },
        },
      ],
    }).compile();
    service = module.get(InventoryService);
    tenantId = (await prisma.tenant.create({ data: { slug, name: `2717 B1 ${slug}` } })).id;
    userId = (
      await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      await prisma.stockLot.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.stockMovement.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.product
        .deleteMany({ where: { tenantId, parentProductId: { not: null } } })
        .catch(() => undefined);
      await prisma.product.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
      await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
    await pool?.end();
  }, 120_000);

  /** Polls until the writer backend is blocked by someone; false if `done()` or the deadline comes first. */
  async function waitUntilWriterBlocked(writerPid: number, done: () => boolean): Promise<boolean> {
    // < 5 s: Prisma's interactive tx timeout is 5 s (race-probe harness rule).
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && !done()) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query("SELECT cardinality(pg_blocking_pids($1::int)) AS n", [
        writerPid,
      ]);
      if (rows[0].n > 0) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  const isDeadlock = (err: unknown) =>
    err !== undefined && (sqlState(err) === "40P01" || /deadlock/i.test(describeErr(err)));
  const isTimeout = (err: unknown) =>
    err !== undefined && /timeout|timed out|55P03|57014/i.test(describeErr(err));

  /**
   * One forced interleave on fresh fixtures. Returns what was observed; the it() asserts.
   * Editor (raw pg): UPDATE family tier price (holds F) ... [barrier] ... propagate to V, COMMIT.
   */
  async function round(n: number) {
    const family = await prisma.product.create({
      data: {
        tenantId,
        name: `Family ${run}-${n}`,
        sku: `FAM-${run}-${n}`,
        unit: "case",
        unitsPerBox: 12,
        pricePerUnit: "10.00",
        priceTier2: "9.50",
        priceTier3: "9.00",
        priceTier4: "8.50",
        priceTier5: "8.00",
        currentStock: 20,
        averageCost: 4,
      },
    });
    const existing = await prisma.product.create({
      data: {
        tenantId,
        name: `Family ${run}-${n} - Cherry`,
        variantName: "Cherry",
        sku: `VAR-${run}-${n}-C`,
        unit: "case",
        unitsPerBox: 12,
        parentProductId: family.id,
        pricePerUnit: "10.00",
        priceTier2: "9.50",
        currentStock: 0,
      },
    });

    const writer = await pool.connect();
    let writerError: unknown;
    let serviceError: unknown;
    let blocked = false;
    let blockerCount = -1;
    let capture: ReturnType<typeof captureRetriedStates> | undefined;
    // The gate: the service pauses in createVariantRowInTx (first call only) until released.
    let gateReached!: () => void;
    let gateRelease!: () => void;
    const reached = new Promise<void>((r) => (gateReached = r));
    const released = new Promise<void>((r) => (gateRelease = r));
    let gated = false;
    const original = (InventoryService.prototype as any).createVariantRowInTx;
    const gateSpy = jest
      .spyOn(service as any, "createVariantRowInTx")
      .mockImplementation(async function (this: unknown, ...args: unknown[]) {
        if (!gated) {
          gated = true;
          gateReached();
          await released;
        }
        return original.apply(this, args);
      });
    try {
      // Records the SQLSTATE of each attempt the service's retryOnTxConflict re-ran (see header).
      capture = captureRetriedStates("inventory.assignToVariants");
      let settled = false;
      // ONE call: the service retries a plain 40001/P2034 itself (SA-587e); no retry loop here.
      const running = (async () => {
        try {
          await tenantCtx.run(tenantId, () =>
            service.assignToVariants(
              {
                parentProductId: family.id,
                assignments: [
                  { productId: existing.id, qty: 5 },
                  { newVariant: { name: "Grape" }, qty: 5 },
                ],
              } as any,
              userId,
            ),
          );
        } catch (err) {
          serviceError = err;
        } finally {
          settled = true;
          gateReached(); // never leave the round waiting on a gate the service died before
        }
      })();

      // 1. the service runs first and pauses on the gate (parent movement + V written, F not yet
      //    taken FOR UPDATE by the old order; held FOR UPDATE by the fixed order)
      await reached;
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout = '4s'");
      const writerPid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);

      // 2. the writer's F FOR UPDATE queues behind the service; the barrier waits until Postgres
      //    reports the writer BLOCKED (fixed order: by the service's F lock; old order: by the
      //    service's FK KEY SHARE), so the interleave is real, not assumed.
      let writerLock: Promise<unknown> | undefined;
      if (!settled) {
        writerLock = writer
          .query('SELECT id FROM "Product" WHERE id = $1 FOR UPDATE', [family.id])
          .catch((err) => {
            writerError = err;
          });
        blocked = await waitUntilWriterBlocked(writerPid, () => settled);
        if (blocked) {
          blockerCount = (
            await pool.query("SELECT cardinality(pg_blocking_pids($1::int)) AS n", [writerPid])
          ).rows[0].n;
        }
      }

      // 3. release the gate; the service proceeds to the new-variant F FOR UPDATE
      gateRelease();
      if (writerLock) await writerLock;
      await running;
      if (!writerError) {
        try {
          // the writer now holds F: propagate the edited tier price (what propagateFamilyPrice
          // does) to F and every variant, then COMMIT
          await writer.query('UPDATE "Product" SET "priceTier2" = 8.75 WHERE id = $1', [family.id]);
          await writer.query(
            'UPDATE "Product" SET "priceTier2" = 8.75 WHERE "parentProductId" = $1',
            [family.id],
          );
          await writer.query("COMMIT");
        } catch (err) {
          writerError = err;
          await writer.query("ROLLBACK").catch(() => undefined);
        }
      } else {
        await writer.query("ROLLBACK").catch(() => undefined);
      }
    } finally {
      gateRelease();
      gateSpy.mockRestore();
      capture?.restore();
      writer.release();
    }

    // wait for the refetch: read only after both sides have settled and committed
    const parentAfter = await prisma.product.findUniqueOrThrow({ where: { id: family.id } });
    const variantAfter = await prisma.product.findUniqueOrThrow({ where: { id: existing.id } });
    const created = await prisma.product.findMany({
      where: { tenantId, parentProductId: family.id, variantName: "Grape" },
    });
    return {
      blocked,
      blockerCount,
      retriedStates: capture ? [...capture.states] : [],
      writerError,
      serviceError,
      parentAfter,
      variantAfter,
      created,
    };
  }

  it("assign [existing V, new W] vs a family price edit (F then V), 3 rounds: no 40P01, writer queues behind the paused service, both effects applied", async () => {
    for (let n = 1; n <= 3; n += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await round(n);

      // (a0) REVERT-RED, on the CODE: the service's retry ABSORBS a deadlock, so serviceError is
      //      "none" even on the old order. Only the recorded retried-attempt SQLSTATEs (and the
      //      writer's own error) show it: old order => a 40P01 in EVERY round (the V <-> F cycle
      //      is forced each time); fixed => none. Plain 40001/P2034 retries are the expected SSI
      //      case: allowed, and both operations must still FULFIL (asserted below).
      expect({
        n,
        deadlocks: r.retriedStates.filter((s) => s === "40P01").length,
        writerDeadlock: isDeadlock(r.writerError),
      }).toEqual({ n, deadlocks: 0, writerDeadlock: false });
      expect(
        r.retriedStates.every((s) => ["40001", "P2034", "TransactionWriteConflict"].includes(s)),
      ).toBe(true);

      // (a) REVERT-RED: without the family lock the service's KEY SHARE -> FOR UPDATE upgrade
      //     deadlocks against the queued writer (40P01, EVERY round). Fixed: neither side.
      expect({ n, dead: isDeadlock(r.writerError) || isDeadlock(r.serviceError) }).toEqual({
        n,
        dead: false,
      });
      expect(describeErr(r.writerError)).not.toMatch(/40P01|deadlock|timeout/i);
      expect(describeErr(r.serviceError)).not.toMatch(/40P01|deadlock|timeout/i);
      expect(isTimeout(r.writerError) || isTimeout(r.serviceError)).toBe(false);
      expect({
        n,
        writer: describeErr(r.writerError),
        service: describeErr(r.serviceError),
      }).toEqual({ n, writer: "none", service: "none" });

      // (b) the forced interleave really happened: the writer queued behind exactly one backend
      expect({ n, blocked: r.blocked, blockerCount: r.blockerCount }).toEqual({
        n,
        blocked: true,
        blockerCount: 1,
      });

      // (c) end state: stock moved exactly once AND the edited tier price reached V and W
      expect(Number(r.parentAfter.currentStock)).toBe(10);
      expect(Number(r.variantAfter.currentStock)).toBe(5);
      expect(Number(r.variantAfter.priceTier2)).toBe(8.75);
      expect(r.created).toHaveLength(1);
      expect(Number(r.created[0].currentStock)).toBe(5);
      expect(Number(r.created[0].priceTier2)).toBe(8.75);
    }
  }, 90_000);
});
