/**
 * O5 (inventory TEST-PLAN, B695): two parallel reopens of the same CANCELLED order must re-decrement once.
 * Stock 10, an order of 3 cancelled and credited (counter 10). Reopen takes the item-CANCELLED lines with a
 * plain read, flips them with an updateMany whose result it ignores, then re-books by a relative decrement
 * under the Product lock: no compare-and-set on the status, so the loser re-books the same 3 after the
 * winner commits. Correct: one reopen wins (the other is refused/no-ops), counter 7, ONE UNCANCEL movement.
 *
 * RED on master by design (tests only, no fix): stock expected 7, received 4 (the 3 booked twice).
 * Linked bug: B695. Real OrdersService + real Postgres; test tenant only.
 *
 * RACE HARNESS (held-row, deterministic; traps from reference_db_race_probe_harness_traps):
 *  - A side connection holds FOR NO KEY UPDATE on the Product row (conflicts with the FOR UPDATE reopen
 *    takes, never with the KEY SHARE a child insert takes), so reopen A parks on the product lock AFTER
 *    flipping the order's lines; reopen B then reads the still-CANCELLED lines and parks on A's line locks.
 *  - Entry is ASSERTED before the outcome is trusted: exactly 1 blocked backend (blocked by the holder),
 *    then exactly 2 (one by the holder, one by a non-holder). Count = every blocked backend of this
 *    database (`datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`).
 *  - Every wait is <= 3 s (Prisma's interactive tx timeout is 5 s; the stock lock timeout is 5 s).
 *  - Lock order here is the single Product row; reopen locks Product rows sorted by (rank, id).
 */
import { Client } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";

describeDb("O5 / B695: concurrent reopen of one cancelled order re-decrements once", () => {
  let w: OrderStockWorld;

  beforeAll(async () => {
    w = await buildOrderStockWorld("o5", "order-stock-o5-reopen-race.db.spec.ts");
  }, 120_000);
  afterAll(async () => {
    await w?.cleanup();
  }, 120_000);

  /** Every blocked backend of THIS database, with who blocks it. */
  async function blocked(): Promise<Array<{ pid: number; blockers: number[] }>> {
    const { rows } = await w.pool.query(
      `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    return rows.map((r: any) => ({ pid: Number(r.pid), blockers: r.blockers.map(Number) }));
  }

  /** Polls (<= 3 s) until exactly `n` backends are blocked; throws with what it saw otherwise. */
  async function waitForBlocked(n: number) {
    const deadline = Date.now() + 3000;
    let seen: Awaited<ReturnType<typeof blocked>> = [];
    while (Date.now() < deadline) {
      seen = await blocked();
      if (seen.length === n) return seen;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `race entry not reached: wanted ${n} blocked backend(s), saw ${JSON.stringify(seen)}`,
    );
  }

  it("B695: two parallel reopens of a cancelled order of 3 leave stock 7 with one UNCANCEL movement", async () => {
    const p = await w.product("o5", 10);
    const { order } = await w.bookOrder({
      status: "CANCELLED",
      cancelled: true,
      lines: [{ productId: p, qty: 3 }],
    });
    expect(await w.stockOf(p)).toBe(10); // fixture sanity: cancelled and credited back

    const holder = new Client({ connectionString: requireLocalDatabaseUrl() });
    await holder.connect();
    const holderPid = Number((await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    let held = true;
    const release = async () => {
      if (!held) return;
      held = false;
      await holder.query("ROLLBACK");
    };
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT id FROM "Product" WHERE id = $1 FOR NO KEY UPDATE`, [p]);

      const reopen = () => w.inTenant(() => w.orders.reopenOrder(order.id));
      const first = reopen().then(
        (v: unknown) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      const afterFirst = await waitForBlocked(1);
      expect(afterFirst[0].blockers).toEqual([holderPid]); // A parks on the held Product row

      const second = reopen().then(
        (v: unknown) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      const afterSecond = await waitForBlocked(2);
      const byHolder = afterSecond.filter((b) => b.blockers.includes(holderPid));
      const byOther = afterSecond.filter((b) => !b.blockers.includes(holderPid));
      expect([byHolder.length, byOther.length]).toEqual([1, 1]); // B parks on A's line locks

      await release();
      await Promise.all([first, second]); // both settle; the stock and the ledger decide
    } finally {
      await release().catch(() => undefined);
      await holder.end();
    }

    // The bug's own wrong value: the same 3 booked twice (4), not once (7).
    expect(await w.stockOf(p)).toBe(7);
    const uncancel = (await w.movements(p)).filter((m) => m.notes === "UNCANCEL");
    expect(uncancel.map((m) => Number(m.quantity))).toEqual([-3]);
    await expectLedgerConsistent(w.tenantId, [p]);
  }, 120_000);
});
