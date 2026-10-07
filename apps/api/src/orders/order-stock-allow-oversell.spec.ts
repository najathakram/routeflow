import { ConflictException } from "@nestjs/common";
import { Prisma, UserRole } from "@prisma/client";
import {
  CUSTOMER_INSUFFICIENT_STOCK_MESSAGE,
  decrementStockForSale,
  settleStockForEdit,
  type OrderStockDeps,
} from "./order-stock";

/**
 * WS9: the locked stock section receives ONLY a resolved boolean (SA-606c — never a policy read
 * here). `decrementStockForSale(…, allowOversell, …)` and `settleStockForEdit(…, opts)` are the two
 * entry points; `opts.allowOversell`, when present, REPLACES the role test.
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
  return { tx };
}

const prod = (stock: number): P => ({
  id: "p",
  name: "Widget",
  currentStock: stock,
  unitsPerBox: null,
});
const line = (qty: number) => ({
  productId: "p",
  qty,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
});

beforeEach(() => warn.mockClear());

describe("decrementStockForSale allowOversell", () => {
  it("true: a 6-vs-5 line succeeds, stock goes to -1 and a SALE movement is written", async () => {
    const products = [prod(5)];
    const { tx } = fakeTx(products);
    await decrementStockForSale(deps, tx, [{ productId: "p", qty: 6 }], true, event);
    expect(products[0].currentStock).toBe(-1);
    expect(tx.stockMovement.create).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("false: a 6-vs-5 line throws ConflictException and writes nothing", async () => {
    const products = [prod(5)];
    const { tx } = fakeTx(products);
    await expect(
      decrementStockForSale(deps, tx, [{ productId: "p", qty: 6 }], false, event),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(products[0].currentStock).toBe(5);
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });
});

describe("settleStockForEdit opts.allowOversell", () => {
  const order = { id: "o-1", status: "PENDING" };
  const run = (
    products: P[],
    user: any,
    opts?: { allowOversell?: boolean },
  ): { p: Promise<void>; products: P[] } => {
    const { tx } = fakeTx(products);
    return {
      p: settleStockForEdit(deps, tx, order, [line(1)], [line(9)], user, undefined, opts),
      products,
    };
  };

  it("opts absent + CUSTOMER increase past stock is refused (unchanged)", async () => {
    const r = run([prod(3)], { role: UserRole.CUSTOMER });
    await expect(r.p).rejects.toBeInstanceOf(ConflictException);
    expect(r.products[0].currentStock).toBe(3);
  });

  it("opts absent + OPERATOR oversells with a warn (unchanged)", async () => {
    const r = run([prod(3)], { role: UserRole.OPERATOR });
    await expect(r.p).resolves.toBeUndefined();
    expect(r.products[0].currentStock).toBe(-5);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("allowOversell=true + CUSTOMER: warn and oversell", async () => {
    const r = run([prod(3)], { role: UserRole.CUSTOMER }, { allowOversell: true });
    await expect(r.p).resolves.toBeUndefined();
    expect(r.products[0].currentStock).toBe(-5);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("allowOversell=false + OPERATOR is refused", async () => {
    const r = run([prod(3)], { role: UserRole.OPERATOR }, { allowOversell: false });
    await expect(r.p).rejects.toBeInstanceOf(ConflictException);
    expect(r.products[0].currentStock).toBe(3);
  });

  it("allowOversell=false + DRIVER is refused", async () => {
    const r = run([prod(3)], { role: UserRole.DRIVER }, { allowOversell: false });
    await expect(r.p).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("OOS PR2 (R4): the stock refusal is CODED, and a buyer never sees stock numbers", () => {
  const body = (e: unknown) => (e as ConflictException).getResponse() as Record<string, unknown>;
  const refuseSale = async (customerFacing?: boolean) => {
    const { tx } = fakeTx([prod(5)]);
    return decrementStockForSale(deps, tx, [line(6)], false, { ...event, customerFacing }).then(
      () => null,
      (e) => e,
    );
  };

  it("sale path, buyer: code INSUFFICIENT_STOCK with the FIXED copy; no product, no numbers", async () => {
    const err = await refuseSale(true);
    expect(err).toBeInstanceOf(ConflictException);
    expect(body(err)).toEqual({
      code: "INSUFFICIENT_STOCK",
      message: CUSTOMER_INSUFFICIENT_STOCK_MESSAGE,
    });
    // no digits, no product name, and not the "available: N, requested: M" shape of the staff message
    expect(String(body(err).message)).not.toMatch(/\d|Widget|available:|requested:/);
  });

  it("sale path, staff / driver: the same code, and the numbers are kept", async () => {
    for (const customerFacing of [false, undefined]) {
      const err = await refuseSale(customerFacing);
      expect(body(err).code).toBe("INSUFFICIENT_STOCK");
      expect(String(body(err).message)).toBe(
        "Insufficient stock: Widget (available: 5, requested: 6)",
      );
    }
  });

  const refuseEdit = (role: UserRole) => {
    const { tx } = fakeTx([prod(3)]);
    const order = { id: "o-1", lineItems: [line(1)] } as never;
    return settleStockForEdit(
      deps,
      tx,
      order,
      [line(1)],
      [line(9)],
      { role } as never,
      undefined,
      undefined,
    )
      .then(() => null)
      .catch((e) => e);
  };

  it("edit path, buyer: code INSUFFICIENT_STOCK, fixed copy, no productId / available / requested", async () => {
    const err = await refuseEdit(UserRole.CUSTOMER);
    expect(body(err)).toEqual({
      code: "INSUFFICIENT_STOCK",
      message: CUSTOMER_INSUFFICIENT_STOCK_MESSAGE,
    });
  });

  it("edit path, a driver keeps the numbers (available / requested / productId)", async () => {
    const err = await refuseEdit(UserRole.DRIVER);
    expect(body(err)).toMatchObject({
      code: "INSUFFICIENT_STOCK",
      productId: "p",
      available: 3,
      requested: 9,
    });
    expect(String(body(err).message)).toMatch(/available: 3, requested: 9/);
  });
});
