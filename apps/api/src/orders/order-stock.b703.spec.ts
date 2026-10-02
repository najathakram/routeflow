import { Prisma } from "@prisma/client";
import { decrementStockForSale, settleStockForEdit, type OrderStockDeps } from "./order-stock";

/**
 * B703 (SA-136b, folded into B562 PR-2): `currentStock` counts PIECES, so every order stock path
 * converts each line to pieces ONCE — `linePieceQty(li, livePack)`: the line's own `unitsPerBox`
 * snapshot first, the product's live pack only as the fallback, a Units line as already pieces — and
 * feeds that one number to BOTH the counter write and the SALE row's `quantity`. Before this, a
 * box-unaware line (boxes/pieces null, no unitLabel: qty is a BOX count) moved the piece counter by
 * its box count, and the SALE row would have made that under-decrement permanent history.
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
const plain = (): P => ({ id: "pl", name: "Loose", currentStock: 100, unitsPerBox: null });

describe("B703 — decrementStockForSale moves the counter and books the row in PIECES", () => {
  it("a box-unaware 2-box line on a 12-pack decrements 24 and books −24", async () => {
    const products = [pack12()];
    const { tx, rows } = fakeTx(products);

    await decrementStockForSale(deps, tx, [{ productId: "p12", qty: 2 }], true, event);

    expect(products[0].currentStock).toBe(76);
    expect(rows()).toEqual([{ productId: "p12", quantity: -24, stockAfter: 76 }]);
  });

  it("the line's own pack snapshot wins over the live pack", async () => {
    const products = [pack12()];
    const { tx, rows } = fakeTx(products);

    await decrementStockForSale(
      deps,
      tx,
      [{ productId: "p12", qty: 2, boxes: null, pieces: null, unitsPerBox: 6 }],
      true,
      event,
    );

    expect(rows()).toEqual([{ productId: "p12", quantity: -12, stockAfter: 88 }]);
  });

  it("a unit Case line decrements its stored pieces (a Units line is already in pieces)", async () => {
    const products = [pack12()];
    const { tx, rows } = fakeTx(products);

    await decrementStockForSale(
      deps,
      tx,
      [
        {
          productId: "p12",
          qty: 5,
          boxes: null,
          pieces: null,
          unitsPerBox: null,
          unitLabel: "Case",
        },
      ],
      true,
      event,
    );

    expect(rows()).toEqual([{ productId: "p12", quantity: -5, stockAfter: 95 }]);
  });

  it("a box-split line (qty already pieces) and a plain product are unchanged", async () => {
    const products = [pack12(), plain()];
    const { tx, rows } = fakeTx(products);

    await decrementStockForSale(
      deps,
      tx,
      [
        { productId: "p12", qty: 27, boxes: 2, pieces: 3, unitsPerBox: 12 },
        { productId: "pl", qty: 3 },
      ],
      true,
      event,
    );

    expect(rows()).toEqual([
      { productId: "p12", quantity: -27, stockAfter: 73 },
      { productId: "pl", quantity: -3, stockAfter: 97 },
    ]);
  });

  it("the oversell guard compares pieces: 9 boxes of a 12-pack against 100 in stock blocks a customer", async () => {
    const { tx } = fakeTx([pack12()]);

    await expect(
      decrementStockForSale(deps, tx, [{ productId: "p12", qty: 9 }], false, event),
    ).rejects.toThrow(/requested: 108/);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("B703 — settleStockForEdit settles the delta and the undelivered cap in PIECES", () => {
  const order = { id: "o-1", status: "PENDING" };

  it("an increase of one box on a box-unaware line decrements 12 and books −12", async () => {
    const products = [pack12()];
    const { tx, rows } = fakeTx(products);

    await settleStockForEdit(
      deps,
      tx,
      order,
      [{ productId: "p12", qty: 2, boxes: null, pieces: null, unitsPerBox: null }],
      [{ productId: "p12", qty: 3, boxes: null, pieces: null, unitsPerBox: null }],
    );

    expect(rows()).toEqual([{ productId: "p12", quantity: -12, stockAfter: 88 }]);
  });

  it("an edit-decrease credits min(−delta, undelivered) in pieces: 2 boxes, 1 delivered, → 0 credits 12", async () => {
    const products = [pack12()];
    const { tx, rows } = fakeTx(products);

    await settleStockForEdit(
      deps,
      tx,
      order,
      [{ productId: "p12", qty: 2, deliveredQty: 1, boxes: null, pieces: null, unitsPerBox: null }],
      [],
    );

    expect(products[0].currentStock).toBe(112);
    expect(rows()).toEqual([{ productId: "p12", quantity: 12, stockAfter: 112 }]);
  });

  it("re-keying 2 box-unaware boxes as a 24-piece box-split line moves nothing", async () => {
    const products = [pack12()];
    const { tx, rows } = fakeTx(products);

    await settleStockForEdit(
      deps,
      tx,
      order,
      [{ productId: "p12", qty: 2, boxes: null, pieces: null, unitsPerBox: null }],
      [{ productId: "p12", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 }],
    );

    expect(tx.product.update).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  it("an unchanged box-unaware line neither locks nor reads (the short circuit holds at any pack)", async () => {
    const { tx } = fakeTx([pack12()]);
    const line = { productId: "p12", qty: 2, boxes: null, pieces: null, unitsPerBox: null };

    await settleStockForEdit(deps, tx, order, [line], [{ ...line }]);

    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.product.findMany).not.toHaveBeenCalled();
  });

  it("a plain product's edit is unchanged: 5 → 3 credits 2", async () => {
    const products = [plain()];
    const { tx, rows } = fakeTx(products);

    await settleStockForEdit(
      deps,
      tx,
      order,
      [{ productId: "pl", qty: 5 }],
      [{ productId: "pl", qty: 3 }],
    );

    expect(rows()).toEqual([{ productId: "pl", quantity: 2, stockAfter: 102 }]);
  });
});
