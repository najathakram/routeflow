/**
 * SA-584 B1 (#2717 M2 fold) — real-Postgres proof that `assignToVariants` (mode `on`) takes the
 * FAMILY row before any variant row, so it cannot deadlock against a family price edit
 * (house order: family -> recipe product -> variant/component rows).
 *
 * One deterministic interleaving on two connections, repeated for 3 rounds on fresh fixtures:
 *   1. the EDITOR (a raw `pg` connection) plays the family price edit: it UPDATEs the family tier
 *      price, holding the FAMILY row F until COMMIT;
 *   2. the SERVICE starts assignToVariants [existing V, new W]; a barrier waits until Postgres
 *      reports it BLOCKED by the editor (`pg_blocking_pids`), so the interleaving is real, then
 *      asserts the lock edges: exactly one blocked backend, waiting on F's tuple lock (pg_locks),
 *      while V can still be locked NOWAIT by a third connection (the service holds no V lock);
 *   3. only then does the editor propagate to V (what `propagateFamilyPrice` does next) and commit.
 * Before the fix the service had already written V (holding its row lock) and blocked later on the
 * family (new W -> `familyPricesForNewVariant`): step 3 closes V -> F against F -> V and Postgres
 * aborts one side with 40P01. Fixed: the service blocks on the family while holding nothing, the
 * editor takes V at once, and both finish; V and W both end with the edited tier price. If the
 * Serializable service tx gets a plain 40001 (it snapshotted before the editor committed), the
 * service's own retryOnTxConflict (SA-587e) re-runs it; that is the SSI case, never a deadlock.
 *
 * WHY THE WRITER TAKES F `FOR NO KEY UPDATE` (not FOR UPDATE): a real family price edit is an
 * UPDATE of non-key columns, which takes exactly that mode. It matters here: assignToVariants
 * inserts a StockMovement whose FK takes FOR KEY SHARE on the family row, and FOR UPDATE conflicts
 * with KEY SHARE. With a FOR UPDATE writer the OLD (variant-first) order therefore blocked on that
 * FK insert BEFORE it wrote any variant, never held V, and the spec stayed green against the bug
 * (F2's finding, #2554). NO KEY UPDATE lets the old order get past the FK insert, write V, and only
 * then block on the family read (FOR UPDATE), which is the real V -> F edge.
 *
 * REVERT-RED MECHANISM (old order, family lock moved after the target loop): the service holds V
 * (row update) and waits on F (new W -> familyPricesForNewVariant FOR UPDATE) while the writer holds
 * F and, once released by the barrier, wants V: a V <-> F cycle. Postgres aborts one side (40P01),
 * so either `writer` or `service` reports 40P01 and this spec fails. Fixed order: the service
 * takes F first, blocks holding nothing, the writer takes V and commits, then the service runs.
 *
 * RETRY INSTRUMENTATION (SA-587e): retryOnTxConflict absorbs the revert's 40P01 (it retries a
 * deadlock like a 40001), so with the retry in place the revert does not surface as a service
 * error. The spec records the SQLSTATE of every retried attempt by spying on Nest's
 * Logger.prototype.warn (common/testing/tx-retry-capture.ts; the retry logs one line per retried
 * attempt) and asserts ZERO 40P01 each of 3 rounds; the reverted order forces the cycle every
 * round, so it records at least one 40P01 per round and fails all three.
 *
 * The lock-edge assert: `blocked` must be true (the service really waited on the writer's family
 * lock) and no 40P01 may be retried or reported by either side. The tuple lock the assign backend holds on F is
 * GRANTED (it is the first waiter; it waits on the writer's transactionid). WRITTEN, NOT RUN by the fold implementer: F2 owns the
 * DB lane (`npm run local:test:db`). Throwaway `qa-2717-b1-<run>` tenant (assertTestTenant).
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
import { isFirstWaiterOnEditorRow, pollUntil, LockRow } from "../common/testing/lock-edge";

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

  /** Polls until some backend is blocked by `blockerPid`; false if `done()` or the deadline comes first. */
  async function waitUntilBlockedBy(blockerPid: number, done: () => boolean): Promise<boolean> {
    // < 5 s: Prisma's interactive tx timeout is 5 s (race-probe harness rule).
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline && !done()) {
      // eslint-disable-next-line no-await-in-loop
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
        [blockerPid],
      );
      if (rows[0].n > 0) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
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
    // No ctid is stored anywhere: the editor's UPDATE moves the tuple and a pre-UPDATE ctid goes
    // stale (see common/testing/lock-edge.ts). The family edge is matched by pid + editor xid.
    const writer = await pool.connect();
    const probe = await pool.connect();
    let writerError: unknown;
    let serviceError: unknown;
    let blocked = false;
    let blockedBackends = -1;
    let blockedOnFamily = false;
    let serviceHoldsVariant = true;
    let capture: ReturnType<typeof captureRetriedStates> | undefined;
    try {
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout = '4s'");
      const pid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const editorXid = String((await writer.query("SELECT txid_current()::text AS x")).rows[0].x);
      // 1. the family price edit: UPDATE the family tier price. This takes F in FOR NO KEY UPDATE
      //    mode (see the header) and leaves it held until COMMIT.
      await writer.query('UPDATE "Product" SET "priceTier2" = 8.75 WHERE id = $1', [family.id]);

      let settled = false;
      // Records the SQLSTATE of each attempt the service's retryOnTxConflict re-ran (see header).
      capture = captureRetriedStates("inventory.assignToVariants");
      const attempt = () =>
        tenantCtx.run(tenantId, () =>
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
      // The service retries a plain 40001/P2034 itself (SA-587e retryOnTxConflict), so the spec
      // makes ONE call and asserts on its outcome; there is no retry loop here.
      const running = (async () => {
        try {
          await attempt();
        } catch (err) {
          serviceError = err;
        } finally {
          settled = true;
        }
      })();

      // 2. lock-edge assert: the service must really be waiting on the editor
      blocked = await waitUntilBlockedBy(pid, () => settled);
      if (blocked) {
        // count ALL backends the editor blocks (must be exactly the one assign backend)
        blockedBackends = (
          await pool.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
            [pid],
          )
        ).rows[0].n;
        // ... and it waits on the FAMILY row F. The editor has updated ONLY F so far, so a backend
        //     blocked by it is queued on F. Postgres queues a row-lock waiter as: it GRANTS itself
        //     the row's heavyweight tuple lock, then waits (not granted) on the holder's
        //     transactionid. Match that by the assign pid + the editor's xid, never by ctid; poll
        //     (bounded, 25 ms) so scheduling jitter cannot flake the read.
        blockedOnFamily =
          (await pollUntil(async () => {
            const { rows: waiters } = await pool.query(
              "SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))",
              [pid],
            );
            if (waiters.length !== 1) return undefined;
            const { rows } = await pool.query(
              `SELECT locktype, granted, relation::regclass::text AS relation,
                      transactionid::text AS transactionid
                 FROM pg_locks WHERE pid = $1`,
              [waiters[0].pid],
            );
            return isFirstWaiterOnEditorRow(rows as LockRow[], editorXid) ? true : undefined;
          })) === true;
        // ... while holding NO lock on the variant row V. Row locks are not in pg_locks, so probe
        // it: FOR UPDATE NOWAIT succeeds iff nobody (in particular the assign backend) holds V.
        await probe.query("BEGIN");
        try {
          await probe.query('SELECT id FROM "Product" WHERE id = $1 FOR UPDATE NOWAIT', [
            existing.id,
          ]);
          serviceHoldsVariant = false;
        } catch {
          serviceHoldsVariant = true;
        } finally {
          await probe.query("ROLLBACK").catch(() => undefined);
        }
      }
      try {
        // 3. release: propagateFamilyPrice's next lock + write, the variant row V, then COMMIT
        await writer.query(
          'UPDATE "Product" SET "priceTier2" = 8.75 WHERE "parentProductId" = $1',
          [family.id],
        );
        await writer.query("COMMIT");
      } catch (err) {
        writerError = err;
        await writer.query("ROLLBACK").catch(() => undefined);
      }
      await running;
    } finally {
      capture?.restore();
      writer.release();
      probe.release();
    }

    // wait for the refetch: read only after both sides have settled and committed
    const parentAfter = await prisma.product.findUniqueOrThrow({ where: { id: family.id } });
    const variantAfter = await prisma.product.findUniqueOrThrow({ where: { id: existing.id } });
    const created = await prisma.product.findMany({
      where: { tenantId, parentProductId: family.id, variantName: "Grape" },
    });
    return {
      blocked,
      blockedBackends,
      blockedOnFamily,
      serviceHoldsVariant,
      retriedStates: capture ? [...capture.states] : [],
      writerError,
      serviceError,
      parentAfter,
      variantAfter,
      created,
    };
  }

  it("assign [existing V, new W] vs a family price edit (F then V), 3 rounds: no 40P01, assign waits on F holding no V lock, both effects applied", async () => {
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

      // (a) REVERT-RED: under the old variant-first order the service holds V and waits on F while
      //     the editor holds F and wants V: 40P01 on one side, EVERY round. Fixed: neither.
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

      // (b) lock edges (old order: service holds V, so serviceHoldsVariant is true and this fails)
      expect({
        n,
        blocked: r.blocked,
        blockedBackends: r.blockedBackends,
        blockedOnFamily: r.blockedOnFamily,
        serviceHoldsVariant: r.serviceHoldsVariant,
      }).toEqual({
        n,
        blocked: true,
        blockedBackends: 1,
        blockedOnFamily: true,
        serviceHoldsVariant: false,
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
