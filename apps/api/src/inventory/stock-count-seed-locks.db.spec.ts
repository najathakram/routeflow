/**
 * Row 562 S1, real Postgres: `advisoryXactLocks` (common/db-locks.ts), the one-statement form of the
 * per-product `stock-count-product` lock a seeding batch takes.
 *
 *  (S4) every distinct key of the batch is held, in one statement, until the transaction ends.
 *  (S5) two transactions locking the same keys in opposite caller order do not deadlock.
 */
import { advisoryXactLocks } from "../common/db-locks";
import { describeDb } from "../common/testing/db-spec";
import { COUNT_SEED_BATCH } from "./stock-count-seed";
import { useCountDbHarness } from "./testing/count-db-harness";

describeDb("row 562 S1 - advisoryXactLocks", () => {
  const h = useCountDbHarness("stock-count-seed-locks.db.spec");

  it("the batch size is 200", () => {
    expect(COUNT_SEED_BATCH).toBe(200);
  });

  it("(S4) advisoryXactLocks holds one lock per distinct key until the transaction ends", async () => {
    const w = await h.seedCountWorld("s4", 1, { lines: false });
    const keys = ["k-3", "k-1", "k-2", "k-1"]; // unsorted, with a duplicate

    const held = await h.inTenant(h.A, w, () =>
      h.A.prisma.tenantTransaction(async (tx: any) => {
        await advisoryXactLocks(tx, "stock-count-product", keys);
        const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted`;
        return n;
      }),
    );

    expect(held).toBe(3);
    const [{ after }] = (
      await h.pool.query(
        `SELECT count(*)::int AS after FROM pg_locks WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()`,
      )
    ).rows;
    expect(after).toBe(0);
  }, 60_000);

  it("(S5) two transactions that name the same keys in opposite order do not deadlock", async () => {
    const w = await h.seedCountWorld("s5", 1, { lines: false });
    const keys = Array.from({ length: 150 }, (_, i) => `k-${String(i).padStart(3, "0")}`);
    const run = (s: typeof h.A, order: string[]) =>
      h.inTenant(s, w, () =>
        s.prisma.tenantTransaction(async (tx: any) => {
          await advisoryXactLocks(tx, "stock-count-product", order);
          await tx.$executeRaw`SELECT pg_sleep(0.05)`; // hold them while the other one asks
          return true;
        }),
      );

    const results = await Promise.all([run(h.A, keys), run(h.B, [...keys].reverse())]);

    expect(results).toEqual([true, true]);
  }, 60_000);
});
