import { Prisma } from "@prisma/client";
import { settleStockForEdit, type OrderStockDeps } from "./order-stock";

/**
 * B1082 (B2): can staff edit or remove lines of a carrier order that is WITH the carrier, and does the edit
 * put the removed pieces back on the shelf? OBSERVED first: yes (R1 lets staff edit an OUT_FOR_DELIVERY
 * order and `settleStockForEdit` credits the undelivered remainder of a removed / reduced line, even
 * though the parcel is out). `blockCredits` (set by updateOrderItems for a with-carrier order) refuses any
 * edit that would credit stock, with a coded 409; increases still pass.
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

  it("blockCredits does not touch an increase or a no-op edit", async () => {
    const products = [pack12()];
    const { tx, rows } = fakeTx(products);
    await settleStockForEdit(deps, tx, shipped, [line(2)], [line(3)], undefined, undefined, {
      blockCredits: true,
    });
    expect(rows()).toEqual([{ productId: "p12", quantity: -12, stockAfter: 88 }]);
    await settleStockForEdit(deps, tx, shipped, [line(3)], [line(3)], undefined, undefined, {
      blockCredits: true,
    });
    expect(rows()).toHaveLength(1);
  });
});
