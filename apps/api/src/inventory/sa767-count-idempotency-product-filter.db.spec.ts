/**
 * Row 354 (SA-767 follow-up, fix A). Real Postgres.
 *
 * `commitStockCount` (the legacy client-session endpoint) answers a replay from `StockMovement.reference =
 * STOCK_COUNT-<sessionId>`. That read named no product, so it was an unbounded scan of the tenant's ledger
 * (there is no `reference` index) AND it matched ANY product's movement carrying that reference. It now reads
 * only the counted products' movements (`productId in`), through the existing `productId` index.
 *
 *  (R1) a movement of ANOTHER product carrying this session's reference is not this count's replay: the count
 *       applies. Red on master: the read matches the stray row and the count returns alreadyCommitted with
 *       nothing written.
 *  (G1) guard: a true replay (same session, same products) is still alreadyCommitted, same movements, one write.
 */
import { randomUUID } from "crypto";
import { describeDb } from "../common/testing/db-spec";
import { useCountDbHarness } from "./testing/count-db-harness";

describeDb("row 354 - the count idempotency read is bounded by the counted products", () => {
  const h = useCountDbHarness("sa767-count-idempotency-product-filter.db.spec");
  const dto = (sessionId: string, productId: string, quantity: number) => ({
    sessionId,
    items: [{ productId, quantity, mode: "REPLACE" as const }],
  });

  it("(R1) another product's movement with this session's reference does not make the count a replay", async () => {
    const w = await h.seedCountWorld("r1", 2, { lines: false });
    const [p1, p2] = [w.idOf(1), w.idOf(2)];
    const sessionId = randomUUID();
    // an unrelated movement of p2 that happens to carry this session's reference
    await h.A.prisma.stockMovement.create({
      data: {
        tenantId: w.tenantId,
        productId: p2,
        type: "ADJUSTMENT",
        quantity: -1,
        stockAfter: 99,
        reference: `STOCK_COUNT-${sessionId}`,
        performedById: w.userId,
      },
    });

    const res: any = await h.inTenant(h.A, w, () =>
      h.A.inventory.commitStockCount(dto(sessionId, p1, 90), w.userId),
    );
    const p1Moves = await h.A.prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId, productId: p1, reference: `STOCK_COUNT-${sessionId}` },
    });
    console.log(
      `row354(R1) observed: alreadyCommitted=${res.alreadyCommitted} applied=${res.applied} ` +
        `p1Stock=${await h.stockOfId(p1)} p1Movements=${p1Moves.length}`,
    );
    expect(res.alreadyCommitted).toBeFalsy();
    expect(await h.stockOfId(p1)).toBe(90);
    expect(p1Moves).toHaveLength(1);
  }, 90_000);

  it("(G1) a true replay (same session, same products) is still alreadyCommitted: one movement, same ids, stock unchanged", async () => {
    const w = await h.seedCountWorld("g1", 1, { lines: false });
    const p1 = w.idOf(1);
    const sessionId = randomUUID();
    const first: any = await h.inTenant(h.A, w, () =>
      h.A.inventory.commitStockCount(dto(sessionId, p1, 90), w.userId),
    );
    const again: any = await h.inTenant(h.B, w, () =>
      h.B.inventory.commitStockCount(dto(sessionId, p1, 90), w.userId),
    );
    expect(first.alreadyCommitted).toBeFalsy();
    expect(again).toMatchObject({ alreadyCommitted: true, applied: 1, skipped: 0 });
    expect(again.movementIds).toEqual(first.movementIds);
    expect(await h.stockOfId(p1)).toBe(90);
    expect(
      await h.A.prisma.stockMovement.count({
        where: { tenantId: w.tenantId, reference: `STOCK_COUNT-${sessionId}` },
      }),
    ).toBe(1);
  }, 90_000);
});
