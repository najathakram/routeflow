/**
 * Row 354 / SA-1005 Amendment A-1. Real Postgres. Pins master's answer; no production line changes.
 *
 * `commitStockCount` (the legacy client-session endpoint) answers from `StockMovement.reference =
 * STOCK_COUNT-<sessionId>` alone: a count id stays ONE count. If that id has already written stock, any
 * re-send, over the same products or other ones, answers `alreadyCommitted` and writes nothing. Narrowing the
 * read to `productId in <this request's products>` would turn that into a product-level guard: a re-send over
 * other products would write a second count under one id, and a product with no movement under the id would be
 * re-pointed (undoing sales made since). Rows go through `commitStockCount` with no planted movements.
 *
 *  (R1) commit S on p1, re-send S on p2 only: alreadyCommitted, p2 stock unchanged, no p2 movement.
 *  (R3) commit S as {p1 at its current stock (no movement), p2 changed}, then a sale of p1, then re-send S on
 *       p1 only: alreadyCommitted, p1 keeps the sale, no p1 movement under S.
 *  (G1) a true replay (same session, same products) is still alreadyCommitted, same movements, one write.
 *
 * Mutant check: with `productId: { in: productIds }` put back in the replay read, R1 and R3 both fail.
 */
import { randomUUID } from "crypto";
import { describeDb } from "../common/testing/db-spec";
import { useCountDbHarness } from "./testing/count-db-harness";

describeDb("row 354 - a count id stays one count (the replay guard is session-level)", () => {
  const h = useCountDbHarness("row354-count-replay-session-level.db.spec");
  const line = (productId: string, quantity: number) => ({
    productId,
    quantity,
    mode: "REPLACE" as const,
  });
  const dto = (sessionId: string, ...items: ReturnType<typeof line>[]) => ({ sessionId, items });
  const movementsUnder = (tenantId: string, sessionId: string, productId: string) =>
    h.A.prisma.stockMovement.count({
      where: { tenantId, productId, reference: `STOCK_COUNT-${sessionId}` },
    });

  it("(R1) a re-send of the id over other products only is alreadyCommitted and writes nothing", async () => {
    const w = await h.seedCountWorld("r1", 2, { lines: false });
    const [p1, p2] = [w.idOf(1), w.idOf(2)];
    const sessionId = randomUUID();
    const first: any = await h.inTenant(h.A, w, () =>
      h.A.inventory.commitStockCount(dto(sessionId, line(p1, 90)), w.userId),
    );
    expect(first.alreadyCommitted).toBeFalsy();
    expect(await movementsUnder(w.tenantId, sessionId, p1)).toBe(1);

    const again: any = await h.inTenant(h.B, w, () =>
      h.B.inventory.commitStockCount(dto(sessionId, line(p2, 90)), w.userId),
    );
    console.log(
      `row354(R1) observed: alreadyCommitted=${again.alreadyCommitted} applied=${again.applied} ` +
        `p2Stock=${await h.stockOfId(p2)} p2Movements=${await movementsUnder(w.tenantId, sessionId, p2)}`,
    );
    expect(again.alreadyCommitted).toBe(true);
    expect(await h.stockOfId(p2)).toBe(100);
    expect(await movementsUnder(w.tenantId, sessionId, p2)).toBe(0);
    expect(await h.stockOfId(p1)).toBe(90);
  }, 90_000);

  it("(R3) a re-send over a product with no movement under the id does not undo a sale made since", async () => {
    const w = await h.seedCountWorld("r3", 2, { lines: false });
    const [p1, p2] = [w.idOf(1), w.idOf(2)];
    const sessionId = randomUUID();
    // p1 counted at its current stock (a no-change line writes no movement); p2 changed
    const first: any = await h.inTenant(h.A, w, () =>
      h.A.inventory.commitStockCount(dto(sessionId, line(p1, 100), line(p2, 90)), w.userId),
    );
    expect(first.alreadyCommitted).toBeFalsy();
    expect(await movementsUnder(w.tenantId, sessionId, p1)).toBe(0);
    expect(await movementsUnder(w.tenantId, sessionId, p2)).toBe(1);

    await h.sell(p1, 5);
    expect(await h.stockOfId(p1)).toBe(95);

    const again: any = await h.inTenant(h.B, w, () =>
      h.B.inventory.commitStockCount(dto(sessionId, line(p1, 100)), w.userId),
    );
    console.log(
      `row354(R3) observed: alreadyCommitted=${again.alreadyCommitted} applied=${again.applied} ` +
        `p1Stock=${await h.stockOfId(p1)} p1Movements=${await movementsUnder(w.tenantId, sessionId, p1)}`,
    );
    expect(again.alreadyCommitted).toBe(true);
    expect(await h.stockOfId(p1)).toBe(95);
    expect(await movementsUnder(w.tenantId, sessionId, p1)).toBe(0);
  }, 90_000);

  it("(G1) a true replay (same session, same products) is still alreadyCommitted: one movement, same ids, stock unchanged", async () => {
    const w = await h.seedCountWorld("g1", 1, { lines: false });
    const p1 = w.idOf(1);
    const sessionId = randomUUID();
    const first: any = await h.inTenant(h.A, w, () =>
      h.A.inventory.commitStockCount(dto(sessionId, line(p1, 90)), w.userId),
    );
    const again: any = await h.inTenant(h.B, w, () =>
      h.B.inventory.commitStockCount(dto(sessionId, line(p1, 90)), w.userId),
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
