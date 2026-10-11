import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { readFileSync } from "fs";
import * as path from "path";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { restoreStockForReopen, settleStockForEdit, type OrderStockDeps } from "./order-stock";

/**
 * B1050 (SA-703) — PINS ONLY, written ahead of the fix. A line's `deliveredQty` is never rewritten by
 * an operator edit, so an edit may drop `qty` below it; the next raise then decremented the FULL
 * increase and the credit side used a POOLED per-product cap (Σheld − Σdelivered), so delivered goods
 * were paid for twice. Fix model every case asserts: booked C = Σ(matched by non-null id) max(q, d)
 * + max(Σunmatched final q, Σunmatched held d); delta = C_after − C_before; no pooled cap; an
 * id-less / replace-all line set falls back to the pooled behaviour; cancel = Σ max(0, q − d);
 * reopen matches by index. Lines are never matched on an undefined id.
 */

const deps: OrderStockDeps = { logger: { warn: jest.fn() }, tenantId: "t-1" };
type P = { id: string; name: string; currentStock: number; unitsPerBox: number | null };

/** A transaction double that applies the writes to `products` and records every SALE row. */
function fakeTx(products: P[]) {
  const byId = (id: string) => products.find((p) => p.id === id)!;
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(0), // the FOR UPDATE lock
    // SA-714: the backorder marker reads its lines' rows and writes only that tag (none held here).
    orderItem: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
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
        const p = byId(where.id);
        p.currentStock += Number(data.currentStock.increment ?? 0);
        p.currentStock -= Number(data.currentStock.decrement ?? 0);
        return { ...p, currentStock: new Prisma.Decimal(p.currentStock) };
      }),
    },
    stockLot: { findMany: jest.fn().mockResolvedValue([]) },
    stockMovement: { create: jest.fn(async () => ({ id: "m" })) },
  };
  const rows = () =>
    tx.stockMovement.create.mock.calls.map(([{ data }]: any) => Number(data.quantity));
  return { tx, rows, updates: () => tx.product.update.mock.calls.length };
}

const prod = (stock: number): P => ({
  id: "p1",
  name: "Water",
  currentStock: stock,
  unitsPerBox: null,
});
const order = { id: "o-1", status: "PENDING" };
const held = (id: string | undefined, qty: number, deliveredQty: number) => ({
  ...(id ? { id } : {}),
  productId: "p1",
  qty,
  deliveredQty,
  status: "PENDING",
});
const line = (id: string | undefined, qty: number) => ({
  ...(id ? { id } : {}),
  productId: "p1",
  qty,
});

describe("B1050 — settleStockForEdit books max(q, delivered) per matched line", () => {
  it("T1: raising a line back up to its delivered qty moves nothing (held 6, delivered 10 → 10)", async () => {
    const products = [prod(90)];
    const { tx, rows, updates } = fakeTx(products);
    await settleStockForEdit(deps, tx, order, [held("L1", 6, 10)], [line("L1", 10)]);
    expect(updates()).toBe(0);
    expect(rows()).toEqual([]);
    expect(products[0].currentStock).toBe(90);
  });

  it("T2: raising 2 (delivered 4) to 10 decrements only 6; reducing 10 (delivered 4) to 2 credits 6", async () => {
    const up = [prod(96)];
    const a = fakeTx(up);
    await settleStockForEdit(deps, a.tx, order, [held("L1", 2, 4)], [line("L1", 10)]);
    expect(up[0].currentStock).toBe(90);
    expect(a.rows()).toEqual([-6]);

    const down = [prod(90)];
    const b = fakeTx(down);
    await settleStockForEdit(deps, b.tx, order, [held("L1", 10, 4)], [line("L1", 2)]);
    expect(down[0].currentStock).toBe(96);
    expect(b.rows()).toEqual([6]);
  });

  it("T3: removing a fully delivered line while another line is untouched writes nothing", async () => {
    const products = [prod(90)];
    const { tx, rows, updates } = fakeTx(products);
    await settleStockForEdit(deps, tx, order, [held("a", 5, 5), held("b", 5, 0)], [line("b", 5)]);
    expect(updates()).toBe(0);
    expect(rows()).toEqual([]);
    expect(products[0].currentStock).toBe(90);
  });

  it("T4: cancel credits Σ max(0, q − d) per line, not the pooled remainder (+5, not +1)", async () => {
    const products = [prod(85)];
    const { tx, rows } = fakeTx(products);
    await settleStockForEdit(deps, tx, order, [held("a", 6, 10), held("b", 5, 0)], [], undefined, {
      notes: "CANCEL",
    });
    expect(products[0].currentStock).toBe(90);
    expect(rows()).toEqual([5]);
  });

  it("T5: reopen re-decrements Σ max(0, q − d) per line (−5, not −1)", async () => {
    const products = [prod(100)];
    const { tx, rows } = fakeTx(products);
    await restoreStockForReopen(deps, tx, "o-1", [
      { productId: "p1", qty: 6, deliveredQty: 10 },
      { productId: "p1", qty: 5, deliveredQty: 0 },
    ]);
    expect(products[0].currentStock).toBe(95);
    expect(rows()).toEqual([-5]);
  });

  it("T6: the effective short circuit — a held line split into an id'd line and an id-less line", async () => {
    // held {a, 10, d10}; final {a, 6} + an id-less {4}: the id'd line books max(6,10)=10, the
    // unmatched id-less final books 4 against 0 unmatched held → +4 booked → −4 on the counter.
    const products = [prod(100)];
    const { tx, rows } = fakeTx(products);
    await settleStockForEdit(
      deps,
      tx,
      order,
      [held("a", 10, 10)],
      [line("a", 6), line(undefined, 4)],
    );
    expect(products[0].currentStock).toBe(96);
    expect(rows()).toEqual([-4]);
  });
});

describe("B1050 T7 — #3244's carrier refusals run on RAW deltas, before any effective short circuit", () => {
  it("a delivered-line edit whose EFFECTIVE delta is 0 is still refused with the carrier code", async () => {
    const products = [prod(90)];
    const { tx, updates } = fakeTx(products);
    const run = settleStockForEdit(
      deps,
      tx,
      order,
      [held("L1", 6, 10)],
      [line("L1", 10)],
      undefined,
      undefined,
      { blockCredits: true },
    );
    await expect(run).rejects.toBeInstanceOf(ConflictException);
    await expect(run).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.ORDER_WITH_CARRIER_NO_ADD },
    });
    expect(updates()).toBe(0);
  });

  it("an unlisted-line delta refuses even when the product side nets to zero", async () => {
    const products = [prod(90)];
    const { tx, updates } = fakeTx(products);
    const heldRows = [held("L1", 6, 10), { id: "u1", productId: null, qty: 2, status: "PENDING" }];
    const final = [line("L1", 6), { id: "u1", productId: null, qty: 1 }];
    const run = settleStockForEdit(deps, tx, order, heldRows, final, undefined, undefined, {
      blockCredits: true,
    });
    await expect(run).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.ORDER_WITH_CARRIER_NO_REDUCE },
    });
    expect(updates()).toBe(0);
  });
});

describe("B1050 — green pins that must hold before AND after the fix", () => {
  it("recreated (replace-all): {x,10,d10} → {y,6} writes nothing; → {y,12} decrements 2", async () => {
    const a = [prod(90)];
    const fa = fakeTx(a);
    await settleStockForEdit(
      deps,
      fa.tx,
      order,
      [held("x", 10, 10)],
      [line("y", 6)],
      undefined,
      undefined,
      {
        lineIdentity: "recreated",
      },
    );
    expect(fa.updates()).toBe(0);
    expect(a[0].currentStock).toBe(90);

    const b = [prod(90)];
    const fb = fakeTx(b);
    await settleStockForEdit(
      deps,
      fb.tx,
      order,
      [held("x", 10, 10)],
      [line("y", 12)],
      undefined,
      undefined,
      {
        lineIdentity: "recreated",
      },
    );
    expect(b[0].currentStock).toBe(88);
    expect(fb.rows()).toEqual([-2]);
  });

  it("stable: a struck delivered line never nets against a NEW line — A{5,d5}+B{5}, strike A, add C{3} → −3", async () => {
    // a8a56aca: pooled cap credits 2 (counter 92). 8c72eb3f (pooled unmatched term): delta 0 (counter 90).
    const products = [prod(90)];
    const { tx, rows } = fakeTx(products);
    await settleStockForEdit(
      deps,
      tx,
      order,
      [held("a", 5, 5), held("b", 5, 0)],
      [line("b", 5), line("c", 3)],
    );
    expect(products[0].currentStock).toBe(87);
    expect(rows()).toEqual([-3]);
  });

  it("two id-less lines are never paired with each other (pooled behaviour)", async () => {
    const products = [prod(100)];
    const { tx, rows } = fakeTx(products);
    await settleStockForEdit(
      deps,
      tx,
      order,
      [held(undefined, 5, 0), held(undefined, 5, 0)],
      [line(undefined, 8), line(undefined, 5)],
    );
    expect(products[0].currentStock).toBe(97);
    expect(rows()).toEqual([-3]);
  });
});

describe("B1050 — updateOrderItems wires lineIdentity per branch (SA-703 M1)", () => {
  const src = readFileSync(path.join(__dirname, "orders.service.ts"), "utf8");
  it("flips to recreated right before BOTH deleteMany + re-create branches", () => {
    // CUSTOMER/DRIVER non-diff, then operator replaceAll.
    expect(src).toMatch(
      /lineIdentity = "recreated";\s*await tx\.orderItem\.deleteMany\(\{\s*where: \{\s*orderId,\s*\.\.\.\(isBuyerEdit/,
    );
    expect(src).toMatch(
      /lineIdentity = "recreated";\s*await tx\.orderItem\.deleteMany\(\{ where: \{ orderId \} \}\);/,
    );
    expect(src.match(/lineIdentity = "recreated"/g)).toHaveLength(2);
  });
  it("defaults to stable and hands the value to the edit settle", () => {
    expect(src).toMatch(/let lineIdentity: "stable" \| "recreated" = "stable";/);
    expect(src).toMatch(/blockCredits: carrierLocked,\s*lineIdentity,/);
  });
});
