/**
 * SA-767 L-2.4 item A (r-note 4 A, option (i)) - `expectedQty` is the product's LIVE stock, read in the
 * same tx, on a line's CREATE and on every ABSOLUTE write (a typed / set total or a recount that
 * replaces `countedQty`). INCREMENT scans never re-stamp. The REPLACE delta stays
 * `countedQty - expectedQty`, applied as an increment on the locked row. Real Postgres.
 *
 *  (A1) the lead's case: counted 100 at stock 100, a sale of 10, an absolute recount of 90 ->
 *       expectedQty 90 -> delta 0 -> final stock 90 (the branch before this change: 80, the sale
 *       subtracted twice).
 *  (A2) a scan-built line (50 increment scans from stock 100, a sale mid-way, no recount) keeps
 *       expected 100: delta -50, the sale survives.
 *  (A3) a sale AFTER the last absolute write is kept in the final stock (regression guard).
 */
import { describeDb } from "../common/testing/db-spec";
import { useCountDbHarness } from "./testing/count-db-harness";

describeDb("SA-767 L-2.4 A - expectedQty re-stamp on absolute count writes", () => {
  const h = useCountDbHarness("sa767-count-restamp.db.spec");

  const lineOf = (w: { sessionId: string }, productId: string) =>
    h.A.prisma.stockCountLine.findFirstOrThrow({ where: { sessionId: w.sessionId, productId } });

  it("(A1) counted 100, a sale of 10, an absolute recount of 90: expectedQty 90, delta 0, final stock 90", async () => {
    const w = await h.seedCountWorld("a1", 1, { lines: false });
    const p = w.idOf(1);

    await h.upsert(h.A, w, { productId: p, countedQty: 100 }); // create: expected 100
    await h.sell(p, 10); // stock 90
    await h.upsert(h.A, w, { productId: p, countedQty: 90 }); // absolute recount
    const line = await lineOf(w, p);
    const res: any = await h.commitSession(h.A, w);

    console.log(
      `SA-767(A1) observed: expectedQty=${Number(line.expectedQty)} applied=${res.applied} ` +
        `finalStock=${await h.stockOfId(p)}`,
    );
    expect(Number(line.expectedQty)).toBe(90);
    expect(res.applied).toBe(0); // delta 0: nothing to write
    expect(await h.stockOfId(p)).toBe(90); // the sale is subtracted once, not twice (80)
    expect((await h.sessionOf(w)).status).toBe("COMMITTED");
  }, 60_000);

  it("(A2) a scan-built line keeps its baseline: 50 increment scans from stock 100 with a sale mid-way", async () => {
    const w = await h.seedCountWorld("a2", 1, { lines: false });
    const p = w.idOf(1);

    for (let i = 0; i < 25; i++)
      await h.upsert(h.A, w, { productId: p, countedQty: 1, increment: true });
    await h.sell(p, 10); // stock 90 while the scans accumulate
    for (let i = 0; i < 25; i++)
      await h.upsert(h.A, w, { productId: p, countedQty: 1, increment: true });
    const line = await lineOf(w, p);
    const res: any = await h.commitSession(h.A, w);

    expect(Number(line.expectedQty)).toBe(100); // never re-stamped by a scan
    expect(Number(line.countedQty)).toBe(50);
    expect(res.applied).toBe(1);
    const [mv] = await h.countMovements(w);
    expect(Number(mv.quantity)).toBe(-50); // counted 50 - expected 100
    expect(await h.stockOfId(p)).toBe(40); // 100 - 10 (sale) - 50 (count delta)
  }, 120_000);

  it("(A3) a sale after the last absolute write is kept in the final stock (regression guard)", async () => {
    const w = await h.seedCountWorld("a3", 1, { lines: false });
    const p = w.idOf(1);

    await h.upsert(h.A, w, { productId: p, countedQty: 95 });
    await h.upsert(h.A, w, { productId: p, countedQty: 90 }); // last absolute write: expected 100
    await h.sell(p, 30); // stock 70, after the last write
    await h.commitSession(h.A, w);

    expect(await h.stockOfId(p)).toBe(60); // 70 + (90 - 100)
  }, 60_000);
});
