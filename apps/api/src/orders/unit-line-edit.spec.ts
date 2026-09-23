import {
  createUnitLine,
  loadUnitCategoryMap,
  updateUnitLine,
  type UnitWriteContext,
} from "./unit-line-edit";
import { resolveLineUnits } from "../products/line-units";
import type { LadderUnit } from "@routeflow/pricing";

/**
 * SA-098 (2026-09-23), a HOLD on #1286: `createUnitLine`/`updateUnitLine` used to defer BOTH the
 * category tax amount and the rate-snapshot trio to the post-mutation `recomputeLineCategoryTaxes`
 * pass. That was safe on master (the pass reads the LIVE category), but becomes a PERMANENT $0
 * levy the moment PR 3's NULL-snapshot rule ("keep the stored amount") lands: a unit line added or
 * edited through this path would carry $0 forever, on the exact path that gates units_v1. Fixed:
 * price + stamp the trio at WRITE, through the same shared `categoryTaxForLine` every other writer
 * uses — never a deferred placeholder.
 */
const regulatedProduct = {
  id: "p1",
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "10.00",
  trackedCategoryId: "cat-1",
};
// Same id as regulatedProduct (reuses the same ladder entry in makeCtx()) — just no category.
const unregulatedProduct = { id: "p1", unit: "Box", unitsPerBox: 24, pricePerUnit: "10.00" };
const units: LadderUnit[] = [
  {
    label: "Case",
    factorToBase: 24,
    price: "220.00",
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
  },
];
const resolved = resolveLineUnits(regulatedProduct, units, { unitLabel: "Case" });
const category = { taxType: "EXCISE_PER_UNIT", rate: 0.5, priceIncludesTax: false };

function makeCtx(): UnitWriteContext & {
  tx: { orderItem: { create: jest.Mock; update: jest.Mock } };
} {
  return {
    tx: { orderItem: { create: jest.fn(), update: jest.fn() } },
    ladders: new Map([["p1", units]]),
    tenantId: "t1",
    tier: () => 1,
    categoryMap: new Map([["cat-1", category]]),
  };
}

describe("createUnitLine / updateUnitLine — price + stamp the trio at write (SA-098)", () => {
  it("createUnitLine on a regulated product carries a NON-NULL trio and a NON-ZERO amount", async () => {
    const ctx = makeCtx();
    await createUnitLine(
      ctx,
      "order-1",
      regulatedProduct,
      resolved,
      { qty: 2, unitLabel: "Case" },
      0,
    );

    expect(ctx.tx.orderItem.create).toHaveBeenCalledTimes(1);
    const data = ctx.tx.orderItem.create.mock.calls[0][0].data;
    // 2 Cases x factor 24 = 48 base pieces; EXCISE_PER_UNIT 0.5/piece = 24.
    expect(data.categoryTaxAmount).toBe(24);
    expect(data.categoryTaxType).toBe("EXCISE_PER_UNIT");
    expect(data.categoryTaxRate).toBe(0.5);
    expect(data.categoryPriceIncludesTax).toBe(false);
  });

  it("updateUnitLine on a regulated product carries a NON-NULL trio and a NON-ZERO amount", async () => {
    const ctx = makeCtx();
    await updateUnitLine(ctx, "line-1", regulatedProduct, resolved, { qty: 2, unitLabel: "Case" });

    expect(ctx.tx.orderItem.update).toHaveBeenCalledTimes(1);
    const data = ctx.tx.orderItem.update.mock.calls[0][0].data;
    expect(data.categoryTaxAmount).toBe(24);
    expect(data.categoryTaxType).toBe("EXCISE_PER_UNIT");
    expect(data.categoryTaxRate).toBe(0.5);
    expect(data.categoryPriceIncludesTax).toBe(false);
  });

  it("a non-regulated product still carries an all-null snapshot and a zero amount — nothing invented", async () => {
    const ctx = makeCtx();
    const unregResolved = resolveLineUnits(unregulatedProduct, units, { unitLabel: "Case" });
    await createUnitLine(
      ctx,
      "order-1",
      unregulatedProduct,
      unregResolved,
      { qty: 2, unitLabel: "Case" },
      0,
    );

    const data = ctx.tx.orderItem.create.mock.calls[0][0].data;
    expect(data.categoryTaxAmount).toBe(0);
    expect(data.categoryTaxType).toBeNull();
    expect(data.categoryTaxRate).toBeNull();
    expect(data.categoryPriceIncludesTax).toBeNull();
  });
});

describe("loadUnitCategoryMap", () => {
  it("skips the query entirely when nothing in products is regulated", async () => {
    const findMany = jest.fn();
    const map = await loadUnitCategoryMap(
      { trackedCategory: { findMany } },
      new Map([["p2", unregulatedProduct]]),
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("fetches and keys by trackedCategoryId for every regulated product, de-duplicated", async () => {
    const findMany = jest.fn().mockResolvedValue([{ id: "cat-1", ...category }]);
    const map = await loadUnitCategoryMap(
      { trackedCategory: { findMany } },
      new Map([
        ["p1", regulatedProduct],
        ["p1b", { ...regulatedProduct, id: "p1b" }],
      ]),
    );
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({ where: { id: { in: ["cat-1"] } } });
    expect(map.get("cat-1")).toEqual({ id: "cat-1", ...category });
  });
});
