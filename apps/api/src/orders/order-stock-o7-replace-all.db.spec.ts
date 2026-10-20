/**
 * O7 (inventory TEST-PLAN, B1191): an operator replace-all edit releases the old lines and books the new
 * ones, with no double count. Stock A 10, B 10, C 10; a PENDING order holds A x3 and B x2 (A 7, B 8). The
 * operator replaces ALL lines with A x5 and C x4 (B dropped): A 5 (a delta of -2 on the 3 it held), B back
 * to 10, C 6. Also the 4 -> 9 repro from the registry row (-5, not -9), and the contrast case: the same body
 * WITHOUT replaceAll:true is a MERGE that adds a new line (-9 is correct there).
 *
 * GREEN on this master (tests only, no fix): B1191 carries an INVALID note in the registry (the filing probe
 * omitted replaceAll:true, so it hit the merge branch; a true replace books -5). The spec stays as the O7
 * regression pin. Linked bug: B1191. Real OrdersService + real Postgres; test tenant only.
 */
import { describeDb } from "../common/testing/db-spec";
import { buildOrderStockWorld, type OrderStockWorld } from "../inventory/testing/order-stock-world";
import { expectLedgerConsistent } from "../inventory/testing/ledger-consistency";

describeDb(
  "O7 / B1191: operator replace-all edit releases old and books new, real Postgres",
  () => {
    let w: OrderStockWorld;

    beforeAll(async () => {
      w = await buildOrderStockWorld("o7", "order-stock-o7-replace-all.db.spec.ts");
    }, 120_000);
    afterAll(async () => {
      await w?.cleanup();
    }, 120_000);

    const edit = (orderId: string, dto: any) =>
      w.inTenant(() => w.orders.updateOrderItems(orderId, dto, w.jwt));
    const line = (productId: string, qty: number) => ({ productId, qty, unitPrice: "5.00" });

    it("B1191: replacing A x3 + B x2 with A x5 + C x4 leaves A 5, B 10, C 6 (old released, new booked once)", async () => {
      const [a, b, c] = [
        await w.product("o7-a", 10),
        await w.product("o7-b", 10),
        await w.product("o7-c", 10),
      ];
      const { order } = await w.bookOrder({
        status: "PENDING",
        lines: [
          { productId: a, qty: 3 },
          { productId: b, qty: 2 },
        ],
      });
      expect([await w.stockOf(a), await w.stockOf(b)]).toEqual([7, 8]); // fixture sanity

      await edit(order.id, { replaceAll: true, items: [line(a, 5), line(c, 4)] });

      expect([await w.stockOf(a), await w.stockOf(b), await w.stockOf(c)]).toEqual([5, 10, 6]);
      const lines = await w.prisma.orderItem.findMany({ where: { orderId: order.id } });
      expect(lines.map((l) => [l.productId, Number(l.qty)]).sort()).toEqual(
        [
          [a, 5],
          [c, 4],
        ].sort(),
      );
      await expectLedgerConsistent(w.tenantId, [a, b, c]);
    }, 120_000);

    it("B1191 repro: replace-all of a 4-unit line to 9 books -5 (stock 6 -> 1), not -9", async () => {
      const p = await w.product("o7-repro", 10);
      const { order } = await w.bookOrder({ status: "PENDING", lines: [{ productId: p, qty: 4 }] });
      expect(await w.stockOf(p)).toBe(6);

      await edit(order.id, { replaceAll: true, items: [line(p, 9)] });

      expect(await w.stockOf(p)).toBe(1);
      await expectLedgerConsistent(w.tenantId, [p]);
    }, 120_000);

    it("contrast: the same body WITHOUT replaceAll:true is a merge that adds a line (4 + 9, stock -9)", async () => {
      const p = await w.product("o7-merge", 20);
      const { order } = await w.bookOrder({ status: "PENDING", lines: [{ productId: p, qty: 4 }] });
      expect(await w.stockOf(p)).toBe(16);

      await edit(order.id, { items: [line(p, 9)] });

      expect(await w.stockOf(p)).toBe(7);
      await expectLedgerConsistent(w.tenantId, [p]);
    }, 120_000);
  },
);
