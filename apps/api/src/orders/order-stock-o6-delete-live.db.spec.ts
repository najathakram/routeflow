/**
 * O6 (inventory TEST-PLAN, B284): deleting a LIVE order must return its creation-time stock.
 * Stock 10, a PENDING order of 3 and a CONFIRMED order of 3 each take 3 (counter 7, then 4 for the pair
 * when both stand). Deleting either must put its 3 back WITH a SALE movement (notes DELETE), or the
 * delete is refused until the order is cancelled. On master `deleteOrder` removes the rows and credits
 * nothing, so the counter stays down forever and the ledger holds the SALE with no matching return.
 *
 * RED on master by design (tests only, no fix): it fails on the bug's own wrong value, stock 7 (expected 10).
 * Linked bug: B284. Real OrdersService + real Postgres through the isolated runner; test tenant only.
 */
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";

describeDb("O6 / B284: delete of a live order returns its stock, real Postgres", () => {
  let w: OrderStockWorld;

  beforeAll(async () => {
    w = await buildOrderStockWorld("o6", "order-stock-o6-delete-live.db.spec.ts");
  }, 120_000);
  afterAll(async () => {
    await w?.cleanup();
  }, 120_000);

  for (const status of ["PENDING", "CONFIRMED"] as const) {
    it(`B284: deleting a ${status} order of 3 from stock 10 puts stock back to 10 (or refuses the delete)`, async () => {
      const p = await w.product(`o6-${status}`, 10);
      const { order } = await w.bookOrder({ status, lines: [{ productId: p, qty: 3 }] });
      expect(await w.stockOf(p)).toBe(7); // fixture sanity: the order holds 3

      const outcome = await w
        .inTenant(() => w.orders.deleteOrder(order.id, w.jwt))
        .then(() => "DELETED" as const)
        .catch((e: any) =>
          e?.getStatus?.() >= 400 && e.getStatus() < 500 ? "REFUSED" : Promise.reject(e),
        );

      if (outcome === "REFUSED") {
        // The accepted alternative: refused until cancel, so nothing moved and the order still stands.
        expect(await w.stockOf(p)).toBe(7);
        expect(await w.prisma.order.count({ where: { id: order.id } })).toBe(1);
      } else {
        // Deleted: the 3 are back, and the ledger says why (a SALE movement noting DELETE).
        expect(await w.stockOf(p)).toBe(10);
        const back = (await w.movements(p)).filter((m) => m.notes === "DELETE");
        expect(back.map((m) => [m.type, Number(m.quantity), Number(m.stockAfter)])).toEqual([
          ["SALE", 3, 10],
        ]);
      }
      await expectLedgerConsistent(w.tenantId, [p]);
    }, 120_000);
  }
});
