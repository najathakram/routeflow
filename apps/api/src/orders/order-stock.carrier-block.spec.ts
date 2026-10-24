import { Prisma } from "@prisma/client";
import { settleStockForEdit, type OrderStockDeps } from "./order-stock";

/**
 * B1082 (B2): can staff edit or remove lines of a carrier order that is WITH the carrier, and does the edit
 * put the removed pieces back on the shelf? OBSERVED first: yes (R1 lets staff edit an OUT_FOR_DELIVERY
 * order and `settleStockForEdit` credits the undelivered remainder of a removed / reduced line, even
 * though the parcel is out). `blockCredits` (set by updateOrderItems for a with-carrier order) refuses any
 * edit that moves stock, with a coded 409: a reduction is ORDER_WITH_CARRIER_NO_REDUCE, an add / increase
 * is ORDER_WITH_CARRIER_NO_ADD (SA-696: the line set is fixed once the parcel is out).
 */

const D = (n: number | string) => new Prisma.Decimal(n);
const deps: OrderStockDeps = { logger: { warn: jest.fn() }, tenantId: "t-1" };
const event = { orderId: "o-1", notes: "CREATE", performedById: "u-1" };

type P = { id: string; name: string; currentStock: number; unitsPerBox: number | null };

/** A transaction double that applies the writes to `products` and records every SALE row. */
function fakeTx(products: P[]) {
  const isSql = (v: any) => typeof v?.sql === "string" && Array.isArray(v?.values);
  const flat = (v: any): any[] =>
    v == null ? [] : isSql(v) ? flat(v.values) : Array.isArray(v) ? v.flatMap(flat) : [v];
  const byId = (id: string) => products.find((p) => p.id === id)!;
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(0), // the FOR UPDATE lock
    // decrementStockForSale's aggregated `UPDATE … FROM (VALUES (id, qty)…) RETURNING`.
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, ...values: any[]) => {
      const bound = flat(values).filter((v) => v !== "t-1");
      const rows: { id: string; currentStock: Prisma.Decimal }[] = [];
      for (let i = 0; i < bound.length; i += 2) {
        const p = byId(bound[i]);
        p.currentStock -= Number(bound[i + 1]);
        rows.push({ id: p.id, currentStock: D(p.currentStock) });
      }
      return rows;
    }),
    product: {
      findMany: jest.fn(async ({ where }: any) =>
        products.filter((p) => where.id.in.includes(p.id)),
      ),
      findFirst: jest.fn(async () => ({
        costingMethod: "AVCO",
        averageCost: D(2),
        standardCost: null,
      })),
      update: jest.fn(async ({ where, data }: any) => {
        const p = byId(where.id);
        p.currentStock += Number(data.currentStock.increment ?? 0);
        p.currentStock -= Number(data.currentStock.decrement ?? 0);
        return { ...p, currentStock: D(p.currentStock) };
      }),
    },
    stockLot: { findMany: jest.fn().mockResolvedValue([]) },
    stockMovement: { create: jest.fn(async () => ({ id: "m" })) },
  };
  const rows = () =>
    tx.stockMovement.create.mock.calls.map(([{ data }]: any) => ({
      productId: data.productId,
      quantity: Number(data.quantity),
      stockAfter: Number(data.stockAfter),
    }));
  return { tx, rows };
}

const pack12 = (): P => ({ id: "p12", name: "Water 12pk", currentStock: 100, unitsPerBox: 12 });
const line = (qty: number) => ({
  productId: "p12",
  qty,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
});
const shipped = { id: "o-1", status: "OUT_FOR_DELIVERY" };

describe("settleStockForEdit on an order with the carrier", () => {
  it("OBSERVED: without the block, removing a line of an OUT_FOR_DELIVERY order credits 24 pieces back", async () => {
    const products = [pack12()];
    const { tx, rows } = fakeTx(products);
    await settleStockForEdit(deps, tx, shipped, [line(2)], []);
    expect(products[0].currentStock).toBe(124);
    expect(rows()).toEqual([{ productId: "p12", quantity: 24, stockAfter: 124 }]);
  });

  it("blockCredits: removing or reducing a line is a coded 409 and nothing is written", async () => {
    for (const final of [[], [line(1)]]) {
      const products = [pack12()];
      const { tx, rows } = fakeTx(products);
      await expect(
        settleStockForEdit(deps, tx, shipped, [line(2)], final, undefined, undefined, {
          blockCredits: true,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: "ORDER_WITH_CARRIER_NO_REDUCE" }),
      });
      expect(products[0].currentStock).toBe(100);
      expect(rows()).toEqual([]);
    }
  });

  it("SA-696: blockCredits refuses an increase or an added line (ORDER_WITH_CARRIER_NO_ADD), nothing written", async () => {
    for (const [held, final] of [
      [[line(2)], [line(3)]], // qty +1
      [[], [line(1)]], // an added line
    ]) {
      const products = [pack12()];
      const { tx, rows } = fakeTx(products);
      await expect(
        settleStockForEdit(deps, tx, shipped, held, final, undefined, undefined, {
          blockCredits: true,
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: "ORDER_WITH_CARRIER_NO_ADD" }),
      });
      expect(products[0].currentStock).toBe(100);
      expect(rows()).toEqual([]);
    }
  });

  it("SA-696: a swap (one product up, another down) is a reduction; a no-op edit passes", async () => {
    const other = { id: "p6", name: "Soda", currentStock: 50, unitsPerBox: null };
    const products = [pack12(), other];
    const { tx, rows } = fakeTx(products);
    await expect(
      settleStockForEdit(
        deps,
        tx,
        shipped,
        [line(2)],
        [{ ...line(1), productId: "p6" }],
        undefined,
        undefined,
        { blockCredits: true },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "ORDER_WITH_CARRIER_NO_REDUCE" }),
    });
    await settleStockForEdit(deps, tx, shipped, [line(3)], [line(3)], undefined, undefined, {
      blockCredits: true,
    });
    expect(rows()).toEqual([]);
  });
});
