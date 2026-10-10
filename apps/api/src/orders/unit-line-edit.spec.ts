import { createUnitLine, updateUnitLine, type UnitWriteContext } from "./unit-line-edit";
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
    orderId: "ord-1", // #2577: every line rewrite is scoped to the edited order
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

  it("updateUnitLine on a SUBSTITUTE to a regulated product carries a NON-NULL trio and a NON-ZERO amount", async () => {
    const ctx = makeCtx();
    await updateUnitLine(
      ctx,
      "line-1",
      regulatedProduct,
      resolved,
      { qty: 2, unitLabel: "Case" },
      true,
    );

    expect(ctx.tx.orderItem.update).toHaveBeenCalledTimes(1);
    const data = ctx.tx.orderItem.update.mock.calls[0][0].data;
    expect(data.categoryTaxAmount).toBe(24);
    expect(data.categoryTaxType).toBe("EXCISE_PER_UNIT");
    expect(data.categoryTaxRate).toBe(0.5);
    expect(data.categoryPriceIncludesTax).toBe(false);
  });

  it("updateUnitLine on a SAME-PRODUCT qty/price edit (isSubstitute: false) never writes the trio keys at all — a rate change since sale must not move it", async () => {
    const ctx = makeCtx();
    await updateUnitLine(
      ctx,
      "line-1",
      regulatedProduct,
      resolved,
      { qty: 4, unitLabel: "Case" },
      false,
    );

    expect(ctx.tx.orderItem.update).toHaveBeenCalledTimes(1);
    const data = ctx.tx.orderItem.update.mock.calls[0][0].data;
    // The trio keys are absent entirely (not null) — Prisma leaves the stored columns untouched.
    expect("categoryTaxType" in data).toBe(false);
    expect("categoryTaxRate" in data).toBe(false);
    expect("categoryPriceIncludesTax" in data).toBe(false);
    // The amount still gets SOME value (deferred to the post-mutation recompute, unchanged from
    // pre-B297 behaviour on this branch) — money isn't what this pin is about.
    expect(typeof data.categoryTaxAmount).toBe("number");
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
