import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  decrementStockForSale,
  settleStockForEdit,
  type OrderStockDeps,
  type StockOutcomeSink,
} from "./order-stock";

/**
 * Buyer backorderPieces (SA-606k): the overshoot is read from the LOCKED decrement's own result
 * (RETURNING / the update's counter), never from an earlier pre-read, and written to an optional
 * sink the caller passes in. A product's backorder = min(piecesRequested, max(0, -newStock)).
 */

const D = (n: number | string) => new Prisma.Decimal(n);
const deps: OrderStockDeps = { logger: { warn: jest.fn() }, tenantId: "t-1" };
const event = (sink: StockOutcomeSink) => ({
  orderId: "o-1",
  notes: "CREATE",
  performedById: "u-1",
  sink,
});
const newSink = (): StockOutcomeSink => ({
  backorderByProduct: new Map(),
  packByProduct: new Map(),
});

type P = { id: string; name: string; currentStock: number; unitsPerBox: number | null };

/** `preReadStock` lets a case make the FOR UPDATE read disagree with the counter the UPDATE hits. */
function fakeTx(products: P[], preReadStock?: Record<string, number>) {
  const isSql = (v: any) => typeof v?.sql === "string" && Array.isArray(v?.values);
  const flat = (v: any): any[] =>
    v == null ? [] : isSql(v) ? flat(v.values) : Array.isArray(v) ? v.flatMap(flat) : [v];
  const byId = (id: string) => products.find((p) => p.id === id)!;
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(0),
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
        products
          .filter((p) => where.id.in.includes(p.id))
          .map((p) => ({ ...p, currentStock: preReadStock?.[p.id] ?? p.currentStock })),
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
  return tx;
}

const prod = (stock: number, unitsPerBox: number | null = null): P => ({
  id: "p",
  name: "Widget",
  currentStock: stock,
  unitsPerBox,
});
const sl = (qty: unknown) => ({
  productId: "p",
  qty,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
});

describe("decrementStockForSale writes the backorder into the sink", () => {
  it("stock 3, buyer asks 7, oversell on -> backorder 4 (pieces), stock -4", async () => {
    const products = [prod(3)];
    const sink = newSink();
    await decrementStockForSale(deps, fakeTx(products), [sl(7)], true, event(sink));
    expect(sink.backorderByProduct.get("p")).toBe(4);
    expect(products[0].currentStock).toBe(-4);
  });

  it("enough stock -> the product records 0", async () => {
    const sink = newSink();
    await decrementStockForSale(deps, fakeTx([prod(10)]), [sl(7)], true, event(sink));
    expect(sink.backorderByProduct.get("p") ?? 0).toBe(0);
  });

  it("a counter already negative caps the backorder at what this order asked for", async () => {
    const sink = newSink();
    await decrementStockForSale(deps, fakeTx([prod(-2)]), [sl(3)], true, event(sink));
    expect(sink.backorderByProduct.get("p")).toBe(3);
  });

  it("two lines of one product sum first: 3 + 4 against 3 -> 4", async () => {
    const sink = newSink();
    await decrementStockForSale(deps, fakeTx([prod(3)]), [sl(3), sl(4)], true, event(sink));
    expect(sink.backorderByProduct.get("p")).toBe(4);
  });

  it("a boxed line is counted in PIECES: 2 boxes of 12 against 10 -> 14", async () => {
    const sink = newSink();
    const line = { productId: "p", qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 };
    await decrementStockForSale(deps, fakeTx([prod(10, 12)]), [line], true, event(sink));
    expect(sink.backorderByProduct.get("p")).toBe(14);
    expect(sink.packByProduct.get("p")).toBe(12);
  });

  it("C8: the figure comes from the decrement's own result, not the earlier pre-read", async () => {
    // The FOR UPDATE read says 10 (so no oversell warning/check trips), but the counter the UPDATE
    // actually moved held 3 -> -4. The response must match the movement (4), never the pre-read (0).
    const sink = newSink();
    await decrementStockForSale(deps, fakeTx([prod(3)], { p: 10 }), [sl(7)], true, event(sink));
    expect(sink.backorderByProduct.get("p")).toBe(4);
  });

  it("oversell off: refuses 409 and the sink is untouched", async () => {
    const sink = newSink();
    await expect(
      decrementStockForSale(deps, fakeTx([prod(3)]), [sl(7)], false, event(sink)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(sink.backorderByProduct.size).toBe(0);
  });
});

describe("decrementStockForSale quantity guard (N3, SA-606k split)", () => {
  it.each([[NaN], [Infinity]])(
    "qty %p -> 409 INVENTORY_QUANTITY_INVALID naming the product, no write",
    async (qty) => {
      const products = [prod(5)];
      const tx = fakeTx(products);
      const err: any = await decrementStockForSale(
        deps,
        tx,
        [sl(qty)],
        true,
        event(newSink()),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "INVENTORY_QUANTITY_INVALID" });
      expect(err.getResponse().message).toContain("Widget");
      expect(products[0].currentStock).toBe(5);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.stockMovement.create).not.toHaveBeenCalled();
    },
  );

  it("a negative line stays a RangeError (N5): never a 4xx, no write", async () => {
    const products = [prod(5)];
    const tx = fakeTx(products);
    await expect(
      decrementStockForSale(deps, tx, [sl(-2)], true, event(newSink())),
    ).rejects.toBeInstanceOf(RangeError);
    expect(products[0].currentStock).toBe(5);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("settleStockForEdit writes THIS edit's backorder into the sink", () => {
  const unit = { boxes: null, pieces: null, unitsPerBox: null };
  const held = (qty: number) => [{ productId: "p", qty, status: "PENDING", ...unit }];
  const final = (qty: number) => [{ productId: "p", qty, ...unit }];
  const order = { id: "o-1", status: "PENDING" };
  const run = (
    products: P[],
    heldQty: number,
    finalQty: number,
    sink: StockOutcomeSink,
    allowOversell = true,
  ) =>
    settleStockForEdit(
      deps,
      fakeTx(products),
      order,
      held(heldQty),
      final(finalQty),
      undefined,
      undefined,
      { allowOversell, sink },
    );

  it("C9 up: 2 -> 7 with 3 left -> delta 5, counter -2 -> backorder 2", async () => {
    const products = [prod(3)];
    const sink = newSink();
    await run(products, 2, 7, sink);
    expect(products[0].currentStock).toBe(-2);
    expect(sink.backorderByProduct.get("p")).toBe(2);
  });

  it("C9 down: 7 -> 2 credits stock back and the product records 0", async () => {
    const products = [prod(-2)];
    const sink = newSink();
    await run(products, 7, 2, sink);
    expect(products[0].currentStock).toBe(3);
    expect(sink.backorderByProduct.get("p") ?? 0).toBe(0);
  });

  it("a same-qty edit touches nothing: no entry", async () => {
    const sink = newSink();
    await run([prod(3)], 2, 2, sink);
    expect(sink.backorderByProduct.size).toBe(0);
  });

  it("oversell off: still the coded 409, sink untouched", async () => {
    const sink = newSink();
    await expect(run([prod(3)], 2, 7, sink, false)).rejects.toBeInstanceOf(ConflictException);
    expect(sink.backorderByProduct.size).toBe(0);
  });
});
