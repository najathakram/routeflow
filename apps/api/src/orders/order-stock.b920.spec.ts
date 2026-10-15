import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  CUSTOMER_INSUFFICIENT_STOCK_MESSAGE,
  decrementStockForSale,
  type OrderStockDeps,
} from "./order-stock";

/**
 * B920: the oversell check in `decrementStockForSale` compared EACH line against `currentStock`
 * separately, so two lines of the same product (3 + 3 pieces against 5 on hand) both passed and
 * stock went to -1 even with `allowOversell` false (a buyer cart). The check must test the
 * PER-PRODUCT total, the same aggregate the decrement writes and the backorder marker reads.
 */

const D = (n: number | string) => new Prisma.Decimal(n);
const warn = jest.fn();
const deps: OrderStockDeps = { logger: { warn }, tenantId: "t-1" };
const event = { orderId: "o-1", notes: "CREATE", performedById: "u-1" };

type P = { id: string; name: string; currentStock: number; unitsPerBox: number | null };

function fakeTx(products: P[]) {
  const isSql = (v: any) => typeof v?.sql === "string" && Array.isArray(v?.values);
  const flat = (v: any): any[] =>
    v == null ? [] : isSql(v) ? flat(v.values) : Array.isArray(v) ? v.flatMap(flat) : [v];
  const byId = (id: string) => products.find((p) => p.id === id)!;
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(0), // the FOR UPDATE lock
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, ...values: any[]) => {
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
      update: jest.fn(),
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

const mango = (stock = 5): P => ({
  id: "mango",
  name: "Mango",
  currentStock: stock,
  unitsPerBox: null,
});
const water = (stock = 20): P => ({
  id: "water",
  name: "Water 12pk",
  currentStock: stock,
  unitsPerBox: 12,
});

async function refusal(run: () => Promise<unknown>): Promise<ConflictException> {
  try {
    await run();
  } catch (e) {
    return e as ConflictException;
  }
  throw new Error("expected a ConflictException, but the call resolved");
}

describe("B920 — decrementStockForSale tests the per-product total, not each line", () => {
  beforeEach(() => warn.mockClear());

  it("a buyer's two lines of 3 against 5 are refused with the fixed copy; nothing is written", async () => {
    const products = [mango()];
    const { tx, rows } = fakeTx(products);

    const err = await refusal(() =>
      decrementStockForSale(
        deps,
        tx,
        [
          { productId: "mango", qty: 3 },
          { productId: "mango", qty: 3 },
        ],
        false,
        { ...event, customerFacing: true },
      ),
    );

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "INSUFFICIENT_STOCK",
      message: CUSTOMER_INSUFFICIENT_STOCK_MESSAGE,
    });
    expect(products[0].currentStock).toBe(5);
    expect(rows()).toEqual([]);
  });

  it("staff (no oversell) get ONE entry per short product carrying the product totals", async () => {
    const products = [mango()];
    const { tx } = fakeTx(products);

    const err = await refusal(() =>
      decrementStockForSale(
        deps,
        tx,
        [
          { productId: "mango", qty: 3 },
          { productId: "mango", qty: 3 },
        ],
        false,
        event,
      ),
    );

    const message = (err.getResponse() as any).message as string;
    expect(message).toBe("Insufficient stock: Mango (available: 5, requested: 6)");
    expect(products[0].currentStock).toBe(5);
  });

  it("two lines that together fit (2 + 3 of 5) go through as ONE decrement and ONE SALE row", async () => {
    const products = [mango()];
    const { tx, rows } = fakeTx(products);

    await decrementStockForSale(
      deps,
      tx,
      [
        { productId: "mango", qty: 2 },
        { productId: "mango", qty: 3 },
      ],
      false,
      event,
    );

    expect(products[0].currentStock).toBe(0);
    expect(rows()).toEqual([{ productId: "mango", quantity: -5, stockAfter: 0 }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sums in PIECES across unit shapes: two box-unaware 1-box lines of a 12-pack vs 20 on hand", async () => {
    const products = [water(20)];
    const { tx } = fakeTx(products);

    const err = await refusal(() =>
      decrementStockForSale(
        deps,
        tx,
        [
          { productId: "water", qty: 1 },
          { productId: "water", qty: 1 },
        ],
        false,
        { ...event, customerFacing: true },
      ),
    );

    expect(err.getResponse()).toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(products[0].currentStock).toBe(20);
  });

  it("names only the product that is short in total; an adequately stocked product is not listed", async () => {
    const products = [mango(5), water(100)];
    const { tx } = fakeTx(products);

    const err = await refusal(() =>
      decrementStockForSale(
        deps,
        tx,
        [
          { productId: "mango", qty: 3 },
          { productId: "water", qty: 1 },
          { productId: "mango", qty: 3 },
          { productId: "water", qty: 1 },
        ],
        false,
        event,
      ),
    );

    const message = (err.getResponse() as any).message as string;
    expect(message).toBe("Insufficient stock: Mango (available: 5, requested: 6)");
    expect(products.map((p) => p.currentStock)).toEqual([5, 100]);
  });

  it("staff with oversell allowed still sell: one warning for the product, stock -1, markers sum to the shortfall", async () => {
    const products = [mango()];
    const { tx, rows } = fakeTx(products);
    const lineA = { productId: "mango", qty: 3, position: 0 };
    const lineB = { productId: "mango", qty: 3, position: 1 };

    const pending = await decrementStockForSale(deps, tx, [lineA, lineB], true, event);

    expect(products[0].currentStock).toBe(-1);
    expect(rows()).toEqual([{ productId: "mango", quantity: -6, stockAfter: -1 }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("Mango (available: 5, requested: 6)");
    // The marker sees the same per-product view: 5 on hand fills line A (3) then 2 of line B, so B is 1 short.
    expect(pending.get(lineA)).toBe(0);
    expect(pending.get(lineB)).toBe(1);
  });
});
