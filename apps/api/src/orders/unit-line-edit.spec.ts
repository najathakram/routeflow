import { createUnitLine, updateUnitLine, type UnitWriteContext } from "./unit-line-edit";
import { resolveLineUnits } from "../products/line-units";
import type { LadderUnit } from "@routeflow/pricing";

/**
 * B297 (SA-088): `createUnitLine`/`updateUnitLine` defer the regulated category tax AMOUNT to the
 * post-mutation `recomputeLineCategoryTaxes` pass (unchanged in this PR — PR3 fixes that site to
 * read a snapshot instead of the live category). The rate-snapshot trio must defer the SAME way —
 * never stamped from a category this call site doesn't actually price with — or a line could end
 * up with categoryTaxAmount: 0 (placeholder) but a real-looking categoryTaxType/Rate, which PR3's
 * recompute would then wrongly trust as "this line's proven rate".
 */
const product = {
  id: "p1",
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "10.00",
  trackedCategoryId: "cat-1",
};
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
const resolved = resolveLineUnits(product, units, { unitLabel: "Case" });

function makeCtx(): UnitWriteContext & {
  tx: { orderItem: { create: jest.Mock; update: jest.Mock } };
} {
  return {
    tx: { orderItem: { create: jest.fn(), update: jest.fn() } },
    ladders: new Map([["p1", units]]),
    tenantId: "t1",
    tier: () => 1,
  };
}

describe("createUnitLine / updateUnitLine — deferred B297 snapshot (SA-088)", () => {
  it("createUnitLine writes a null rate-snapshot alongside the deferred zero amount", async () => {
    const ctx = makeCtx();
    await createUnitLine(ctx, "order-1", product, resolved, { qty: 2, unitLabel: "Case" }, 0);

    expect(ctx.tx.orderItem.create).toHaveBeenCalledTimes(1);
    const data = ctx.tx.orderItem.create.mock.calls[0][0].data;
    expect(data.categoryTaxAmount).toBe(0);
    expect(data.categoryTaxType).toBeNull();
    expect(data.categoryTaxRate).toBeNull();
    expect(data.categoryPriceIncludesTax).toBeNull();
  });

  it("updateUnitLine writes a null rate-snapshot alongside the deferred zero amount", async () => {
    const ctx = makeCtx();
    await updateUnitLine(ctx, "line-1", product, resolved, { qty: 2, unitLabel: "Case" });

    expect(ctx.tx.orderItem.update).toHaveBeenCalledTimes(1);
    const data = ctx.tx.orderItem.update.mock.calls[0][0].data;
    expect(data.categoryTaxAmount).toBe(0);
    expect(data.categoryTaxType).toBeNull();
    expect(data.categoryTaxRate).toBeNull();
    expect(data.categoryPriceIncludesTax).toBeNull();
  });
});
