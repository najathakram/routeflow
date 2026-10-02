import { ConflictException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import {
  decrementStockForSale,
  settleStockForEdit,
  type OrderStockDeps,
  type StockWriteResult,
} from "./order-stock";
import { fakeStockTx, TENANT_ID, type FakeProduct } from "./testing/fake-stock-tx";

/**
 * SA-606k / SA-606n: the locked stock functions RETURN `{ backorderByProduct }`, the overshoot THIS
 * write created per product, derived from the write's own result under the row lock — never from an
 * earlier read. Create: `min(sum_P, max(0, -newStock_P))`. Edit: the same, from the per-product
 * DELTA only (`delta_P > 0`), never a recomputation from raw lines.
 */
const warn = jest.fn();
const error = jest.fn();
const deps: OrderStockDeps = { logger: { warn, error } as any, tenantId: TENANT_ID };
const event = { orderId: "o-1", notes: "CREATE", performedById: "u-1" };

const prod = (id: string, stock: number, pack: number | null = null): FakeProduct => ({
  id,
  name: `Widget ${id}`,
  currentStock: stock,
  unitsPerBox: pack,
});
const ln = (productId: string, qty: number, extra: Record<string, unknown> = {}) => ({
  productId,
  qty,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  ...extra,
});
const backorder = (r: StockWriteResult | void, id: string) =>
  (r as StockWriteResult).backorderByProduct.get(id);

beforeEach(() => {
  warn.mockClear();
  error.mockClear();
});

describe("decrementStockForSale returns backorderByProduct (SA-606k Q1)", () => {
  it.each([
    // stock, requested, expected overshoot
    [5, 8, 3], // C2: short by 3
    [10, 4, 0], // covered
    [5, 5, 0], // exactly covered
    [-4, 6, 6], // already negative from earlier orders: ALL of this write is backordered
    [0, 2, 2],
    [1.5, 2.25, 0.75], // fractional pieces at the column's 3 decimals
  ])("stock %p, request %p -> %p", async (stock, qty, expected) => {
    const tx = fakeStockTx([prod("p", stock)]);
    const r = await decrementStockForSale(deps, tx, [ln("p", qty)], true, event);
    expect(backorder(r, "p")).toBe(expected);
  });

  it("C3: two lines of one product are summed FIRST (4 + 4 against 5 -> 3, not 0)", async () => {
    const tx = fakeStockTx([prod("p", 5)]);
    const r = await decrementStockForSale(deps, tx, [ln("p", 4), ln("p", 4)], true, event);
    expect(backorder(r, "p")).toBe(3);
  });

  it("two products are independent", async () => {
    const tx = fakeStockTx([prod("a", 1), prod("b", 10)]);
    const r = await decrementStockForSale(deps, tx, [ln("a", 4), ln("b", 4)], true, event);
    expect(backorder(r, "a")).toBe(3);
    expect(backorder(r, "b")).toBe(0);
  });

  it("C8: the figure comes from the LOCKED write, not the earlier read", async () => {
    // The read saw 10; a concurrent order took 5 before this write, so the write left -3.
    const tx = fakeStockTx([prod("p", 5)], { p: 10 });
    const r = await decrementStockForSale(deps, tx, [ln("p", 8)], true, event);
    expect(backorder(r, "p")).toBe(3);
  });

  it.each([
    ["box-unaware (qty = boxes, the live pack sizes it)", ln("p", 2)],
    [
      "box-split (qty = pieces, the line's own snapshot)",
      ln("p", 24, { boxes: 2, pieces: 0, unitsPerBox: 12 }),
    ],
  ])("a boxed line is counted in PIECES: %s, 24 against 20 -> 4", async (_name, line) => {
    const tx = fakeStockTx([prod("p", 20, 12)]);
    const r = await decrementStockForSale(deps, tx, [line], true, event);
    expect(backorder(r, "p")).toBe(4);
  });

  it("T5 policy off: a covered order reports 0 (present), a short one still refuses and writes nothing", async () => {
    const covered = fakeStockTx([prod("p", 5)]);
    const r = await decrementStockForSale(deps, covered, [ln("p", 3)], false, event);
    expect(backorder(r, "p")).toBe(0);

    const products = [prod("p", 5)];
    const short = fakeStockTx(products);
    await expect(
      decrementStockForSale(deps, short, [ln("p", 6)], false, event),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(products[0].currentStock).toBe(5);
    expect(short.stockMovement.create).not.toHaveBeenCalled();
  });

  it("no stock lines -> an empty map, not undefined", async () => {
    const r = await decrementStockForSale(deps, fakeStockTx([]), [], true, event);
    expect(r.backorderByProduct.size).toBe(0);
  });

  it("T3: a non-finite piece count is a coded 409 naming the product, before ANY stock write", async () => {
    const products = [prod("p", 5)];
    const tx = fakeStockTx(products);
    const err: any = await decrementStockForSale(
      deps,
      tx,
      [ln("p", Number.POSITIVE_INFINITY)],
      true,
      event,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "INVENTORY_QUANTITY_INVALID" });
    expect(JSON.stringify(err.getResponse())).toContain("Widget p");
    expect(tx.$queryRaw).not.toHaveBeenCalled(); // the aggregated UPDATE never ran
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
    expect(products[0].currentStock).toBe(5);
  });

  it("T4: a negative line is a RangeError (our bug, never a 4xx), with the policy off too", async () => {
    for (const allow of [true, false]) {
      const products = [prod("p", 5)];
      const tx = fakeStockTx(products);
      const err: any = await decrementStockForSale(deps, tx, [ln("p", -3)], allow, event).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(RangeError);
      expect(err).not.toBeInstanceOf(ConflictException);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("Widget p"));
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(products[0].currentStock).toBe(5);
      error.mockClear();
    }
  });
});

describe("settleStockForEdit returns backorderByProduct from the DELTA only (SA-606e C9)", () => {
  const order = { id: "o-1", status: "PENDING" };
  const staff = { sub: "u", role: UserRole.OPERATOR } as any;
  const held = (productId: string, qty: number) => ({ ...ln(productId, qty), deliveredQty: 0 });
  const edit = (tx: any, heldItems: any[], finalItems: any[]) =>
    settleStockForEdit(deps, tx, order, heldItems, finalItems, staff, undefined, {
      allowOversell: true,
    });

  it("raising a product by 5 against 2 available -> 3", async () => {
    const tx = fakeStockTx([prod("p", 2)]);
    const r = await edit(tx, [held("p", 4)], [ln("p", 9)]);
    expect(backorder(r, "p")).toBe(3);
  });

  it("lowering one product reports 0 for it and leaves another product alone", async () => {
    const tx = fakeStockTx([prod("a", 100), prod("b", 1)]);
    const r = await edit(tx, [held("a", 10), held("b", 2)], [ln("a", 4), ln("b", 6)]);
    expect(backorder(r, "a") ?? 0).toBe(0);
    expect(backorder(r, "b")).toBe(3); // +4 against 1 available
  });

  it("an unchanged product is absent or 0 (no lock, no read, no write)", async () => {
    const tx = fakeStockTx([prod("p", 0)]);
    const r = await edit(tx, [held("p", 3)], [ln("p", 3)]);
    expect(backorder(r, "p") ?? 0).toBe(0);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it("stock already negative from OTHER orders: the whole raise is backordered", async () => {
    const tx = fakeStockTx([prod("p", -6)]);
    const r = await edit(tx, [held("p", 2)], [ln("p", 6)]);
    expect(backorder(r, "p")).toBe(4);
  });

  it("a DRAFT edit settles nothing and returns an empty map", async () => {
    const r = await settleStockForEdit(
      deps,
      fakeStockTx([]),
      { id: "o", status: "DRAFT" },
      [],
      [],
      staff,
    );
    expect(r.backorderByProduct.size).toBe(0);
  });
});

describe("type pin (T11b): the stock functions are NOT void", () => {
  it("a void-returning implementation does not satisfy the type (fails check-types if it does)", () => {
    // @ts-expect-error — `async () => {}` resolves to void; the stock function must return a result
    const voidDecrement: typeof decrementStockForSale = async () => {};
    // @ts-expect-error — same for the edit settle
    const voidSettle: typeof settleStockForEdit = async () => {};
    expect([voidDecrement, voidSettle]).toHaveLength(2);
  });
});
