import { CostingMethod, MovementType, Prisma } from "@prisma/client";
import { NotFoundException } from "@nestjs/common";
import { applyStockMovements, type StockMovementRow } from "./stock-movements";
import { lockProductsForStock } from "../common/product-locks";

jest.mock("../common/product-locks", () => ({
  ...jest.requireActual("../common/product-locks"),
  lockProductsForStock: jest.fn().mockResolvedValue(undefined),
}));

const D = (n: number | string) => new Prisma.Decimal(n);

type Seed = {
  id: string;
  stock: number;
  avg: number | null;
  method?: CostingMethod;
};

function makeTx(seeds: Seed[]) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: jest.fn().mockImplementation(async () => {
      calls.push("read");
      return seeds.map((s) => ({
        id: s.id,
        currentStock: D(s.stock),
        averageCost: s.avg == null ? null : D(s.avg),
        costingMethod: s.method ?? CostingMethod.AVCO,
      }));
    }),
    stockMovement: {
      createManyAndReturn: jest.fn().mockImplementation(async ({ data }: { data: any[] }) => {
        calls.push("insert");
        // RETURNING order is not promised: hand the rows back reversed, so the helper must map by id.
        return data
          .map((d) => ({
            id: d.id,
            productId: d.productId,
            stockAfter: d.stockAfter,
            avgCostAfter: d.avgCostAfter,
          }))
          .reverse();
      }),
    },
    product: {
      update: jest.fn().mockImplementation(async () => {
        calls.push("update");
        return {};
      }),
    },
  };
  // A mock of only the slice the helper touches, not a full TransactionClient.
  return { tx: tx as any, calls };
}

/** A quantity row (the target-form cases build their rows inline). */
type QuantityRow = Extract<StockMovementRow, { quantity: unknown }>;
const row = (over: Partial<QuantityRow> & { productId: string }): StockMovementRow => ({
  type: MovementType.ADJUSTMENT,
  quantity: 1,
  ...over,
});

describe("applyStockMovements", () => {
  beforeEach(() => jest.clearAllMocks());

  it("locks the distinct product ids for the tenant", async () => {
    const { tx } = makeTx([{ id: "a", stock: 10, avg: 2 }]);
    await applyStockMovements(tx, "t1", [
      row({ productId: "a", quantity: -1 }),
      row({ productId: "a", quantity: -2 }),
    ]);
    expect(lockProductsForStock).toHaveBeenCalledTimes(1);
    expect(lockProductsForStock).toHaveBeenCalledWith(tx, "t1", ["a"]);
  });

  it("throws NotFoundException for a missing id and writes nothing", async () => {
    const { tx } = makeTx([{ id: "a", stock: 10, avg: 2 }]);
    await expect(
      applyStockMovements(tx, "t1", [row({ productId: "a" }), row({ productId: "foreign" })]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.stockMovement.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("requires a tenant id", async () => {
    const { tx } = makeTx([{ id: "a", stock: 1, avg: null }]);
    await expect(applyStockMovements(tx, "", [row({ productId: "a" })])).rejects.toThrow(
      /tenantId/,
    );
  });

  it("runs stockAfter across two rows of one product and writes the absolute final stock", async () => {
    const { tx } = makeTx([{ id: "a", stock: 10, avg: 2 }]);
    const out = await applyStockMovements(tx, "t1", [
      row({ productId: "a", type: MovementType.SALE, quantity: -3 }),
      row({ productId: "a", type: MovementType.SALE, quantity: -2 }),
    ]);
    expect(out.map((o) => o.stockAfter!.toString())).toEqual(["7", "5"]);
    expect(tx.product.update).toHaveBeenCalledTimes(1);
    const arg = tx.product.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "a" });
    expect(arg.data.currentStock.toString()).toBe("5");
    expect(arg.data).not.toHaveProperty("averageCost");
    expect(JSON.stringify(arg.data)).not.toContain("increment");
  });

  it("folds in lock order but returns the rows in input order", async () => {
    // the read (lock order) is a then b; the input is b, a, b
    const { tx } = makeTx([
      { id: "a", stock: 10, avg: 2 },
      { id: "b", stock: 20, avg: 2 },
    ]);
    const out = await applyStockMovements(tx, "t1", [
      row({ productId: "b", quantity: -1 }),
      row({ productId: "a", quantity: -2 }),
      row({ productId: "b", quantity: -3 }),
    ]);
    const sent = tx.stockMovement.createManyAndReturn.mock.calls[0][0].data;
    expect(sent.map((d: any) => d.productId)).toEqual(["a", "b", "b"]);
    expect(out.map((o) => `${o.productId}:${o.stockAfter}`)).toEqual(["b:19", "a:8", "b:16"]);
  });

  it("stamps createdAt/effectiveAt only for a product that repeats, and sets tenantId", async () => {
    const { tx } = makeTx([
      { id: "a", stock: 10, avg: 2 },
      { id: "b", stock: 10, avg: 2 },
    ]);
    await applyStockMovements(tx, "t1", [
      row({ productId: "a", quantity: -1 }),
      row({ productId: "b", quantity: -1 }),
      row({ productId: "a", quantity: -1 }),
    ]);
    const data = tx.stockMovement.createManyAndReturn.mock.calls[0][0].data;
    const [a1, a2, b1] = data;
    expect(data.every((d: any) => d.tenantId === "t1")).toBe(true);
    expect(b1).not.toHaveProperty("createdAt");
    expect(b1).not.toHaveProperty("effectiveAt");
    expect(a1.createdAt).toBeInstanceOf(Date);
    expect(a2.createdAt.getTime()).toBeGreaterThan(a1.createdAt.getTime());
    expect(a1.effectiveAt).toEqual(a1.createdAt);
    expect(a2.effectiveAt).toEqual(a2.createdAt);
  });

  it("keeps a site-passed createdAt/effectiveAt and sends no undefined optional keys", async () => {
    const { tx } = makeTx([{ id: "a", stock: 10, avg: 2 }]);
    const when = new Date("2026-01-02T03:04:05Z");
    await applyStockMovements(tx, "t1", [
      row({ productId: "a", quantity: -1, createdAt: when, effectiveAt: when, notes: undefined }),
      row({ productId: "a", quantity: -1, createdAt: when }),
    ]);
    const data = tx.stockMovement.createManyAndReturn.mock.calls[0][0].data;
    expect(data[0].createdAt).toBe(when);
    expect(data[1].createdAt).toBe(when);
    expect(data[1]).not.toHaveProperty("effectiveAt");
    expect(data[0]).not.toHaveProperty("notes");
    expect(data[0]).not.toHaveProperty("reference");
  });

  it("receive on AVCO moves the average; on STANDARD it keeps it", async () => {
    const avco = makeTx([{ id: "a", stock: 10, avg: 2 }]);
    const out = await applyStockMovements(avco.tx, "t1", [
      row({
        productId: "a",
        type: MovementType.PURCHASE,
        quantity: 10,
        unitCost: D(4),
        average: { receive: D(4) },
      }),
    ]);
    expect(out[0].avgCostAfter!.toString()).toBe("3");
    expect(avco.tx.product.update.mock.calls[0][0].data.averageCost.toString()).toBe("3");
    expect(avco.tx.product.update.mock.calls[0][0].data.currentStock.toString()).toBe("20");

    const std = makeTx([{ id: "a", stock: 10, avg: 2, method: CostingMethod.STANDARD }]);
    const out2 = await applyStockMovements(std.tx, "t1", [
      row({
        productId: "a",
        type: MovementType.PURCHASE,
        quantity: 10,
        unitCost: D(4),
        average: { receive: D(4) },
      }),
    ]);
    expect(out2[0].avgCostAfter!.toString()).toBe("2");
    expect(std.tx.product.update.mock.calls[0][0].data).not.toHaveProperty("averageCost");
  });

  it("chains receive rows through the running stock and average", async () => {
    const { tx } = makeTx([{ id: "a", stock: 0, avg: null }]);
    const out = await applyStockMovements(tx, "t1", [
      row({
        productId: "a",
        type: MovementType.PURCHASE,
        quantity: 10,
        average: { receive: D(2) },
      }),
      row({
        productId: "a",
        type: MovementType.PURCHASE,
        quantity: 10,
        average: { receive: D(4) },
      }),
    ]);
    expect(out.map((o) => o.avgCostAfter!.toString())).toEqual(["2", "3"]);
    expect(tx.product.update.mock.calls[0][0].data.averageCost.toString()).toBe("3");
  });

  it("reverse recomputes the average, and a null result keeps it", async () => {
    // stock 20 @ 3 = receipt of 10 @ 4 on top of 10 @ 2: reversing gives 10 @ 2
    const a = makeTx([{ id: "a", stock: 20, avg: 3 }]);
    const out = await applyStockMovements(a.tx, "t1", [
      row({
        productId: "a",
        type: MovementType.PURCHASE,
        quantity: -10,
        average: { reverse: D(4) },
      }),
    ]);
    expect(out[0].stockAfter!.toString()).toBe("10");
    expect(out[0].avgCostAfter!.toString()).toBe("2");

    // reversal empties stock: costing returns null, average kept, no averageCost write
    const b = makeTx([{ id: "a", stock: 10, avg: 3 }]);
    const out2 = await applyStockMovements(b.tx, "t1", [
      row({
        productId: "a",
        type: MovementType.PURCHASE,
        quantity: -10,
        average: { reverse: D(4) },
      }),
    ]);
    expect(out2[0].avgCostAfter!.toString()).toBe("3");
    const data = b.tx.product.update.mock.calls[0][0].data;
    expect(data.currentStock.toString()).toBe("0");
    expect(data).not.toHaveProperty("averageCost");
  });

  it("COST_BASIS quantity 0 with set is kept and writes averageCost (and standardCost when asked)", async () => {
    const { tx } = makeTx([{ id: "a", stock: 5, avg: 2, method: CostingMethod.STANDARD }]);
    const out = await applyStockMovements(tx, "t1", [
      row({
        productId: "a",
        type: MovementType.COST_BASIS,
        quantity: 0,
        average: { set: D(7), standard: true },
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].stockAfter!.toString()).toBe("5");
    expect(out[0].avgCostAfter!.toString()).toBe("7");
    const data = tx.product.update.mock.calls[0][0].data;
    expect(data.averageCost.toString()).toBe("7");
    expect(data.standardCost.toString()).toBe("7");
    expect(data.currentStock.toString()).toBe("5");
  });

  it("skips the product write for COST_BASIS quantity 0 that leaves the average unchanged", async () => {
    const { tx } = makeTx([{ id: "a", stock: 5, avg: 2 }]);
    const out = await applyStockMovements(tx, "t1", [
      row({ productId: "a", type: MovementType.COST_BASIS, quantity: 0, average: { set: D(2) } }),
    ]);
    expect(out).toHaveLength(1);
    expect(tx.stockMovement.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("drops quantity-0 rows that are not COST_BASIS", async () => {
    const { tx } = makeTx([{ id: "a", stock: 5, avg: 2 }]);
    const out = await applyStockMovements(tx, "t1", [
      row({ productId: "a", quantity: 0 }),
      row({ productId: "a", quantity: 2 }),
    ]);
    expect(out).toHaveLength(1);
    expect(tx.stockMovement.createManyAndReturn.mock.calls[0][0].data).toHaveLength(1);
    // the only kept row is alone for its product: no stamping
    expect(tx.stockMovement.createManyAndReturn.mock.calls[0][0].data[0]).not.toHaveProperty(
      "createdAt",
    );
  });

  it("writes nothing when every row is dropped", async () => {
    const { tx } = makeTx([{ id: "a", stock: 5, avg: 2 }]);
    const out = await applyStockMovements(tx, "t1", [row({ productId: "a", quantity: 0 })]);
    expect(out).toEqual([]);
    expect(tx.stockMovement.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("a target row books target - the running counter, through the same fold and absolute write", async () => {
    const { tx } = makeTx([{ id: "a", stock: 5, avg: 2 }]);
    const out = await applyStockMovements(tx, "t1", [
      { productId: "a", type: MovementType.ADJUSTMENT, target: 8 },
      // a second count of the same product counts against the stock the first left (8), not 5
      { productId: "a", type: MovementType.ADJUSTMENT, target: 6 },
    ]);
    const sent = tx.stockMovement.createManyAndReturn.mock.calls[0][0].data;
    expect(sent.map((d: any) => d.quantity.toString())).toEqual(["3", "-2"]);
    expect(sent.every((d: any) => !("target" in d))).toBe(true);
    expect(out.map((o) => o.stockAfter!.toString())).toEqual(["8", "6"]);
    expect(out.map((o) => o.avgCostAfter!.toString())).toEqual(["2", "2"]);
    expect(tx.product.update.mock.calls[0][0].data.currentStock.toString()).toBe("6");
  });

  it("a target equal to the counter books no row and no write", async () => {
    const { tx } = makeTx([{ id: "a", stock: 5, avg: 2 }]);
    const out = await applyStockMovements(tx, "t1", [
      { productId: "a", type: MovementType.ADJUSTMENT, target: 5 },
    ]);
    expect(out).toEqual([]);
    expect(tx.stockMovement.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("the plan function runs after the read and gets the locked map", async () => {
    const { tx, calls } = makeTx([{ id: "a", stock: 5, avg: 2 }]);
    const plan = jest.fn().mockImplementation((locked: ReadonlyMap<string, any>) => {
      calls.push("plan");
      return [row({ productId: "a", quantity: locked.get("a").currentStock.negated() })];
    });
    const out = await applyStockMovements(tx, "t1", plan, { productIds: ["a", "a"] });
    expect(calls).toEqual(["read", "plan", "insert", "update"]);
    expect(out[0].stockAfter!.toString()).toBe("0");
    expect(lockProductsForStock).toHaveBeenCalledWith(tx, "t1", ["a"]);
  });

  it("a plan function that throws prevents any write", async () => {
    const { tx } = makeTx([{ id: "a", stock: 1, avg: 2 }]);
    await expect(
      applyStockMovements(
        tx,
        "t1",
        () => {
          throw new Error("INSUFFICIENT_STOCK");
        },
        { productIds: ["a"] },
      ),
    ).rejects.toThrow("INSUFFICIENT_STOCK");
    expect(tx.stockMovement.createManyAndReturn).not.toHaveBeenCalled();
    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it("a plan function without productIds is refused", async () => {
    const { tx } = makeTx([{ id: "a", stock: 1, avg: 2 }]);
    await expect(applyStockMovements(tx, "t1", () => [])).rejects.toThrow(/productIds/);
  });

  it("orders rows by the locked read, keeps input order within a product, returns them in input order", async () => {
    // the locked read returns b before a (lock rank), whatever the input order is
    const { tx } = makeTx([
      { id: "b", stock: 10, avg: 1 },
      { id: "a", stock: 20, avg: 1 },
    ]);
    const out = await applyStockMovements(tx, "t1", [
      row({ productId: "a", quantity: -1, notes: "a1" }),
      row({ productId: "b", quantity: -1, notes: "b1" }),
      row({ productId: "a", quantity: -2, notes: "a2" }),
    ]);
    const data = tx.stockMovement.createManyAndReturn.mock.calls[0][0].data;
    expect(data.map((d: any) => d.notes)).toEqual(["b1", "a1", "a2"]);
    expect(out.map((o) => o.productId)).toEqual(["a", "b", "a"]);
    expect(out.map((o) => o.stockAfter!.toString())).toEqual(["19", "9", "17"]);
    expect(tx.product.update.mock.calls.map((c: any[]) => c[0].where.id)).toEqual(["b", "a"]);
  });
});
