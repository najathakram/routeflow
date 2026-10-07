import { Prisma } from "@prisma/client";
import {
  decrementStockForSale,
  restoreStockForReopen,
  settleStockForEdit,
  type OrderStockDeps,
  type StockLine,
} from "./order-stock";

/**
 * SA-714 R1 / SA-716: the marker writers inside the locked stock section, on a stateful double.
 * SET at a fresh sale (create, promotion, reopen), ADJUST on edit, nothing on cancel/demote/recreate.
 */
const deps: OrderStockDeps = { logger: { warn: jest.fn() }, tenantId: "t-1" };
type Row = { id: string; position: number | null; backorderedPieces: number };
type P = { id: string; name: string; currentStock: number; unitsPerBox: number | null };

function fakeTx(products: P[], rows: Row[]) {
  const writes: Array<{ ids: string[]; value: number }> = [];
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    product: {
      findMany: jest.fn(async ({ where }: any) =>
        products.filter((p) => where.id.in.includes(p.id)),
      ),
      findFirst: jest.fn(async () => ({
        costingMethod: "AVCO",
        averageCost: new Prisma.Decimal(2),
        standardCost: null,
      })),
      update: jest.fn(async ({ where, data }: any) => {
        const p = products.find((x) => x.id === where.id)!;
        p.currentStock += Number(data.currentStock.increment ?? 0);
        p.currentStock -= Number(data.currentStock.decrement ?? 0);
        return { ...p, currentStock: new Prisma.Decimal(p.currentStock) };
      }),
    },
    orderItem: {
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => where.id.in.includes(r.id))),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter(
          (r) => where.id.in.includes(r.id) && r.backorderedPieces !== where.backorderedPieces.not,
        );
        for (const r of hit) r.backorderedPieces = data.backorderedPieces;
        writes.push({ ids: where.id.in, value: data.backorderedPieces });
        return { count: hit.length };
      }),
    },
    stockLot: { findMany: jest.fn().mockResolvedValue([]) },
    stockMovement: { create: jest.fn(async () => ({ id: "m" })) },
  };
  return { tx, writes };
}

const prod = (stock: number): P => ({
  id: "p1",
  name: "Water",
  currentStock: stock,
  unitsPerBox: null,
});
const row = (id: string, position: number | null, marker = 0): Row => ({
  id,
  position,
  backorderedPieces: marker,
});
const order = { id: "o-1", status: "PENDING" };
const sale = { orderId: "o-1", notes: "CREATE", performedById: "u" };
const marker = (rows: Row[], id: string) => rows.find((r) => r.id === id)!.backorderedPieces;

describe("decrementStockForSale SETs the marker from its own result", () => {
  it("create (rows do not exist yet): returns the later line's remainder for the nested create", async () => {
    const { tx, writes } = fakeTx([prod(4)], []);
    const a: StockLine = { productId: "p1", qty: 3, position: 0 };
    const b: StockLine = { productId: "p1", qty: 3, position: 1 };
    const out = await decrementStockForSale(deps, tx, [a, b], true, sale);
    expect([...out.entries()]).toEqual([[b, 2]]);
    expect(writes).toEqual([]); // nothing to write yet: no rows
  });

  it("a fully covered create returns nothing and writes nothing", async () => {
    const { tx, writes } = fakeTx([prod(10)], []);
    const out = await decrementStockForSale(deps, tx, [{ productId: "p1", qty: 3 }], true, sale);
    expect(out.size).toBe(0);
    expect(writes).toEqual([]);
  });

  it("promotion (rows exist): writes by id inside the section — create -> demote -> promote reads 4, not 8", async () => {
    // create booked 4 of 8 (stock 4 then -4); demote returned the 8, so stock is 4 again and the stale marker is 4.
    const rows = [row("L1", 0, 4)];
    const { tx } = fakeTx([prod(4)], rows);
    await decrementStockForSale(
      deps,
      tx,
      [{ id: "L1", productId: "p1", qty: 8, position: 0 }],
      true,
      {
        ...sale,
        notes: "PROMOTE",
      },
    );
    expect(marker(rows, "L1")).toBe(4);
  });

  it("promotion overwrites a stale larger marker and resets one that is no longer backordered", async () => {
    const rows = [row("L1", 0, 9), row("L2", 1, 5)];
    const { tx } = fakeTx([prod(100)], rows);
    await decrementStockForSale(
      deps,
      tx,
      [
        { id: "L1", productId: "p1", qty: 8, position: 0 },
        { id: "L2", productId: "p1", qty: 8, position: 1 },
      ],
      true,
      sale,
    );
    expect([marker(rows, "L1"), marker(rows, "L2")]).toEqual([0, 0]);
  });

  it("allowOversell=false still refuses and marks nothing", async () => {
    const rows = [row("L1", 0, 0)];
    const { tx } = fakeTx([prod(1)], rows);
    await expect(
      decrementStockForSale(deps, tx, [{ id: "L1", productId: "p1", qty: 8 }], false, sale),
    ).rejects.toThrow(/Insufficient stock/);
    expect(marker(rows, "L1")).toBe(0);
  });
});

describe("settleStockForEdit ADJUSTS the marker", () => {
  const user = { role: "OPERATOR" } as any;
  const edit = (rows: Row[], stock: number, heldQty: number, finalQty: number, opts: any = {}) => {
    const t = fakeTx([prod(stock)], rows);
    return {
      ...t,
      run: () =>
        settleStockForEdit(
          deps,
          t.tx,
          order,
          [{ id: "L1", productId: "p1", qty: heldQty, deliveredQty: 0, status: "PENDING" }],
          [{ id: "L1", productId: "p1", qty: finalQty }],
          user,
          undefined,
          { allowOversell: true, ...opts },
        ),
    };
  };

  it("an increase past stock adds its backorder delta to THAT line", async () => {
    const rows = [row("L1", 0, 0)];
    await edit(rows, 2, 5, 10).run(); // +5 with 2 on hand -> 3 backordered
    expect(marker(rows, "L1")).toBe(3);
  });

  it("adds onto what the line already carries", async () => {
    const rows = [row("L1", 0, 2)];
    await edit(rows, 0, 5, 7).run();
    expect(marker(rows, "L1")).toBe(4);
  });

  it("an increase fully covered by stock writes nothing", async () => {
    const rows = [row("L1", 0, 0)];
    const e = edit(rows, 50, 5, 10);
    await e.run();
    expect(marker(rows, "L1")).toBe(0);
    expect(e.writes).toEqual([]);
  });

  it("a reduction releases backordered pieces first: max(0, marker - reduced)", async () => {
    const rows = [row("L1", 0, 6)];
    await edit(rows, 0, 10, 6).run();
    expect(marker(rows, "L1")).toBe(2);
    await edit(rows, 0, 6, 1).run();
    expect(marker(rows, "L1")).toBe(0);
  });

  it("two lines of one product: the increase lands on the later position", async () => {
    const rows = [row("A", 0, 0), row("B", 1, 0)];
    const t = fakeTx([prod(0)], rows);
    await settleStockForEdit(
      deps,
      t.tx,
      order,
      [
        { id: "A", productId: "p1", qty: 2, deliveredQty: 0, status: "PENDING" },
        { id: "B", productId: "p1", qty: 2, deliveredQty: 0, status: "PENDING" },
      ],
      [
        { id: "A", productId: "p1", qty: 4 },
        { id: "B", productId: "p1", qty: 4 },
      ],
      user,
      undefined,
      { allowOversell: true },
    );
    expect([marker(rows, "A"), marker(rows, "B")]).toEqual([2, 2]);
  });

  it("a recreate-mode edit (new ids, B1167) writes no marker", async () => {
    const rows = [row("L1", 0, 5)];
    const e = edit(rows, 0, 5, 10, { lineIdentity: "recreated" });
    await e.run();
    expect(e.writes).toEqual([]);
    expect(marker(rows, "L1")).toBe(5);
  });

  it("cancel / demote (final = none) leave the marker unchanged — it is a fact of the sale", async () => {
    const rows = [row("L1", 0, 5)];
    const t = fakeTx([prod(0)], rows);
    await settleStockForEdit(
      deps,
      t.tx,
      order,
      [{ id: "L1", productId: "p1", qty: 10, deliveredQty: 0, status: "PENDING" }],
      [],
      user,
      { notes: "DEMOTE" },
    );
    expect(t.tx.orderItem.updateMany).not.toHaveBeenCalled();
    expect(marker(rows, "L1")).toBe(5);
  });
});

describe("restoreStockForReopen SETs the marker (its own value, never the stale one)", () => {
  it("cancel -> reopen: the re-decrement's result per line, by position", async () => {
    const rows = [row("A", 0, 5), row("B", 1, 5)];
    const { tx } = fakeTx([prod(4)], rows);
    await restoreStockForReopen(deps, tx, "o-1", [
      { id: "A", productId: "p1", qty: 6, deliveredQty: 0 },
      { id: "B", productId: "p1", qty: 6, deliveredQty: 0 },
    ]);
    expect([marker(rows, "A"), marker(rows, "B")]).toEqual([2, 6]);
  });

  it("a reopen into plenty of stock clears the stale marker", async () => {
    const rows = [row("A", 0, 5)];
    const { tx } = fakeTx([prod(500)], rows);
    await restoreStockForReopen(deps, tx, "o-1", [
      { id: "A", productId: "p1", qty: 6, deliveredQty: 0 },
    ]);
    expect(marker(rows, "A")).toBe(0);
  });
});

describe("recreate-mode create-merge fold CARRIES the held markers (SA-716 M2)", () => {
  const user = { role: "OPERATOR" } as any;
  const fold = (rows: Row[], stock: number, heldQty: number, finalQty: number, opts: any) => {
    const t = fakeTx([prod(stock)], rows);
    return {
      ...t,
      run: () =>
        settleStockForEdit(
          deps,
          t.tx,
          order,
          [{ id: "old", productId: "p1", qty: heldQty, deliveredQty: 0, status: "PENDING" }],
          [{ id: "new", productId: "p1", qty: finalQty }],
          user,
          undefined,
          { allowOversell: true, lineIdentity: "recreated", ...opts },
        ),
    };
  };
  it("marker 3 + an auto-merge adding 2 at 0 stock -> 5", async () => {
    const rows = [row("new", 0, 0)];
    await fold(rows, 0, 3, 5, { markerCarry: new Map([["p1|", 3]]) }).run();
    expect(marker(rows, "new")).toBe(5);
  });
  it("the carry survives a fold with NO stock delta (an untouched product)", async () => {
    const rows = [row("new", 0, 0)];
    await fold(rows, 0, 3, 3, { markerCarry: new Map([["p1|", 3]]) }).run();
    expect(marker(rows, "new")).toBe(3);
  });
  it("operator replaceAll / buyer / driver recreates pass no carry and stay NONE", async () => {
    const rows = [row("new", 0, 0)];
    const f = fold(rows, 0, 3, 5, {});
    await f.run();
    expect(f.writes).toEqual([]);
    expect(marker(rows, "new")).toBe(0);
  });
  it("a different pack group's carry does not land on this line", async () => {
    const rows = [row("new", 0, 0)];
    await fold(rows, 50, 3, 3, { markerCarry: new Map([["p1|24", 3]]) }).run();
    expect(marker(rows, "new")).toBe(0);
  });
});

describe("reopen SETs every re-taken line, even a product with a zero stock delta (SA-716 c)", () => {
  it("a fully delivered cancelled line (delta 0) loses its stale marker", async () => {
    const rows = [row("A", 0, 5)];
    const { tx } = fakeTx([prod(500)], rows);
    await restoreStockForReopen(deps, tx, "o-1", [
      { id: "A", productId: "p1", qty: 6, deliveredQty: 6 },
    ]);
    expect(marker(rows, "A")).toBe(0);
  });
});
