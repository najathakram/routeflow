import { ConflictException } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import { decrementStockForSale, settleStockForEdit, type OrderStockDeps } from "./order-stock";

/**
 * Gap 05 — a buyer who asks for more than is on hand gets ONE uniform, coded 409 on every path
 * (create, DRAFT→PENDING promotion via decrementStockForSale, and order edit): code
 * INSUFFICIENT_STOCK plus `lines[]` with EVERY short product, so clients can say "Only 4 Mango
 * left" instead of echoing server text. The edit path keeps its original top-level
 * productId/available/requested (= lines[0]) for older clients.
 */

const D = (n: number | string) => new Prisma.Decimal(n);
const warn = jest.fn();
const deps: OrderStockDeps = { logger: { warn }, tenantId: "t-1" };
const event = { orderId: "o-1", notes: "CREATE", performedById: "u-1" };

type P = {
  id: string;
  name: string;
  unit?: string;
  currentStock: number;
  unitsPerBox: number | null;
};

function fakeTx(products: P[]) {
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
  return tx;
}

const mango = (): P => ({ id: "mango", name: "Mango 5ct", currentStock: 5, unitsPerBox: null });
const lime = (): P => ({ id: "lime", name: "Lime", currentStock: 0, unitsPerBox: null });

async function caught(fn: () => Promise<unknown>): Promise<ConflictException> {
  try {
    await fn();
  } catch (e) {
    return e as ConflictException;
  }
  throw new Error("expected a ConflictException");
}

beforeEach(() => warn.mockClear());

describe("decrementStockForSale (create + promotion) — coded, line-by-line 409", () => {
  it("a customer ordering 6 against 5 gets code INSUFFICIENT_STOCK and lines[0] = {5, 6}, and nothing is written", async () => {
    const tx = fakeTx([mango()]);
    const err = await caught(() =>
      decrementStockForSale(deps, tx, [{ productId: "mango", qty: 6 }], false, event),
    );
    expect(err).toBeInstanceOf(ConflictException);
    const body = err.getResponse() as any;
    expect(body.code).toBe("INSUFFICIENT_STOCK");
    expect(body.lines).toEqual([
      { productId: "mango", name: "Mango 5ct", available: 5, requested: 6 },
    ]);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it("keeps the readable server message (existing callers match on it)", async () => {
    const err = await caught(() =>
      decrementStockForSale(
        deps,
        fakeTx([mango()]),
        [{ productId: "mango", qty: 6 }],
        false,
        event,
      ),
    );
    expect((err.getResponse() as any).message).toMatch(
      /Insufficient stock: .*available: 5, requested: 6/,
    );
  });

  it("lists EVERY short line, not just the first", async () => {
    const err = await caught(() =>
      decrementStockForSale(
        deps,
        fakeTx([mango(), lime()]),
        [
          { productId: "mango", qty: 6 },
          { productId: "lime", qty: 2 },
        ],
        false,
        event,
      ),
    );
    const { lines } = err.getResponse() as any;
    expect(lines.map((l: any) => [l.productId, l.available, l.requested])).toEqual([
      ["mango", 5, 6],
      ["lime", 0, 2],
    ]);
  });

  it("carries the product's unit label so clients can name the unit", async () => {
    const rice: P = { id: "rice", name: "Rice", unit: "lb", currentStock: 2, unitsPerBox: null };
    const err = await caught(() =>
      decrementStockForSale(deps, fakeTx([rice]), [{ productId: "rice", qty: 5 }], false, event),
    );
    expect((err.getResponse() as any).lines[0]).toMatchObject({
      unit: "lb",
      available: 2,
      requested: 5,
    });
  });

  it("omits the unit for a packed product: Product.unit names the PACK, counts are pieces", async () => {
    const boxed: P = {
      id: "m12",
      name: "Mango 12ct",
      unit: "Box",
      currentStock: 10,
      unitsPerBox: 12,
    };
    const err = await caught(() =>
      decrementStockForSale(deps, fakeTx([boxed]), [{ productId: "m12", qty: 40 }], false, event),
    );
    const line = (err.getResponse() as any).lines[0];
    expect(line.unit).toBeUndefined();
    expect([line.available, line.requested]).toEqual([10, 480]); // a box-unaware line of 40 boxes is 480 pieces;
  });

  it("keeps the unit for an unpacked product (unitsPerBox 1 or null)", async () => {
    for (const unitsPerBox of [null, 1]) {
      const rice: P = { id: "rice", name: "Rice", unit: "lb", currentStock: 2, unitsPerBox };
      const err = await caught(() =>
        decrementStockForSale(deps, fakeTx([rice]), [{ productId: "rice", qty: 5 }], false, event),
      );
      expect((err.getResponse() as any).lines[0].unit).toBe("lb");
    }
  });

  it("staff still oversell with a warning (regression guard)", async () => {
    const products = [mango()];
    await expect(
      decrementStockForSale(deps, fakeTx(products), [{ productId: "mango", qty: 6 }], true, event),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(products[0].currentStock).toBe(-1);
  });
});

describe("settleStockForEdit — same code, lines[] added, legacy top-level fields kept", () => {
  const order = { id: "o-1", status: "PENDING" };
  const held = (qty: number) => ({
    productId: "mango",
    qty,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
  });
  const customer = { role: UserRole.CUSTOMER } as any;
  const driver = { role: UserRole.DRIVER } as any;

  it("a customer edit past stock throws the coded 409 with lines[] and the legacy fields", async () => {
    const err = await caught(() =>
      settleStockForEdit(deps, fakeTx([mango()]), order, [held(1)], [held(9)], customer),
    );
    const body = err.getResponse() as any;
    expect(body.code).toBe("INSUFFICIENT_STOCK");
    expect(body.lines).toEqual([
      { productId: "mango", name: "Mango 5ct", available: 5, requested: 9 },
    ]);
    expect([body.productId, body.available, body.requested]).toEqual(["mango", 5, 9]);
  });

  it("lists every short line on an edit too", async () => {
    const tx = fakeTx([mango(), lime()]);
    const err = await caught(() =>
      settleStockForEdit(
        deps,
        tx,
        order,
        [
          { ...held(1) },
          { productId: "lime", qty: 0, boxes: null, pieces: null, unitsPerBox: null },
        ],
        [
          { ...held(9) },
          { productId: "lime", qty: 3, boxes: null, pieces: null, unitsPerBox: null },
        ],
        customer,
      ),
    );
    const { lines } = err.getResponse() as any;
    expect(lines.map((l: any) => l.productId)).toEqual(["mango", "lime"]);
  });

  it("a driver increase is still refused", async () => {
    const err = await caught(() =>
      settleStockForEdit(deps, fakeTx([mango()]), order, [held(1)], [held(9)], driver),
    );
    expect((err.getResponse() as any).code).toBe("INSUFFICIENT_STOCK");
  });
});
