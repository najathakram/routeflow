import { BadRequestException } from "@nestjs/common";
import type { LadderUnit } from "@routeflow/pricing";
import { resolveLineUnits } from "../products/line-units";
import { MAX_LINE_QTY } from "../orders/unit-line-build";
import { buildInvoiceUnitLine } from "./invoice-unit-line";

// A 24-piece box; a Case of 288 and a factor-1 "Each".
const product = {
  unit: "Box",
  unitsPerBox: 24,
  trackedCategoryId: "cat",
  trackedSubcategoryId: "sub",
};
const level = (label: string, factorToBase: number): LadderUnit => ({
  label,
  factorToBase,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
});
const units = [level("Case", 288), level("Each", 1)];
const category = { taxType: "EXCISE_PER_UNIT", rate: 0.5, priceIncludesTax: false };
const build = (item: Record<string, unknown>, label = "Case", cat: typeof category | null = null) =>
  buildInvoiceUnitLine({
    item: { description: "Widget", productId: "p1", qty: 3, unitPrice: 480, ...item } as never,
    product,
    resolved: resolveLineUnits(product, units, { unitLabel: label }),
    category: cat,
    tenantId: "t-1",
  });

describe("buildInvoiceUnitLine — a manual invoice line sold by a non-pack unit", () => {
  it("stores the typed per-unit price against the unit count, with base-piece qty and the factor snapshot", () => {
    expect(build({})).toMatchObject({
      qty: 864,
      boxes: 3,
      pieces: 0,
      unitsPerBox: 288,
      unitLabel: "Case",
      unitPrice: 480,
      subtotal: 1440,
      promoFreeUnits: null,
      trackedCategoryId: "cat",
      trackedSubcategoryId: "sub",
      tenantId: "t-1",
      msrp: null,
    });
  });

  it("rounds a sub-cent typed price to cents before pricing and storing it (every monetary write is rounded)", () => {
    // 3 Cases at 12.344: rounded price 12.34 -> subtotal 37.02 (an unrounded price would give 37.03)
    expect(build({ unitPrice: 12.344 })).toMatchObject({ unitPrice: 12.34, subtotal: 37.02 });
    // a 2dp price — including an off-ladder one — is untouched (verbatim)
    expect(build({ unitPrice: 300 })).toMatchObject({ unitPrice: 300, subtotal: 900 });
  });

  it("takes the line discount off the subtotal and carries tax rate and notes", () => {
    expect(build({ discount: 40, taxRate: 0.08, notes: "n" })).toMatchObject({
      subtotal: 1400,
      discount: 40,
      taxRate: 0.08,
      notes: "n",
    });
  });

  it("a factor-1 unit is a plain per-piece line that still snapshots factor 1", () => {
    expect(build({ qty: 5, unitPrice: 2.5 }, "Each")).toMatchObject({
      qty: 5,
      boxes: null,
      pieces: null,
      unitsPerBox: 1,
      unitLabel: "Each",
      subtotal: 12.5,
    });
  });

  it("regulated per-unit levies use the BASE piece count, not the unit count", () => {
    // EXCISE $0.50 per piece x 864 pieces
    expect(build({}, "Case", category).categoryTaxAmount).toBe(432);
  });

  it("B297 (SA-088): stamps the rate-snapshot trio alongside categoryTaxAmount, and an all-null snapshot with no category", () => {
    const withCat = build({}, "Case", category);
    expect(withCat.categoryTaxType).toBe("EXCISE_PER_UNIT");
    expect(withCat.categoryTaxRate).toBe(0.5);
    expect(withCat.categoryPriceIncludesTax).toBe(false);

    const noCat = build({}, "Case", null);
    expect(noCat.categoryTaxType).toBeNull();
    expect(noCat.categoryTaxRate).toBeNull();
    expect(noCat.categoryPriceIncludesTax).toBeNull();
  });

  it("refuses boxes, pieces and promotions beside a unit, a fractional or zero count, and an oversize line", () => {
    for (const bad of [
      { boxes: 1 },
      { pieces: 2 },
      { promoFreeUnits: 1 },
      { qty: 2.5 },
      { qty: 0 },
    ]) {
      expect(() => build(bad)).toThrow(BadRequestException);
    }
    expect(() => build({ qty: Math.floor(MAX_LINE_QTY / 288) + 1 })).toThrow(/over the/);
    expect(() => build({ qty: 99_999, unitPrice: 999_999 }, "Each")).toThrow(/total is over/);
  });

  // B682/SA-145: the count/split/pricing math is now buildLine's unit axis —
  // AmbiguousLineError must map to this endpoint's OWN pre-existing wording,
  // not buildLine's own generic message, for both the non-integer and the
  // non-positive count shape.
  it("B682: a fractional or zero count keeps this endpoint's own wording after the buildLine migration", () => {
    expect(() => build({ qty: 2.5 })).toThrow(
      "A line sold by the Case needs a whole number of Case.",
    );
    expect(() => build({ qty: 0 })).toThrow(
      "A line sold by the Case needs a whole number of Case.",
    );
  });

  it("only a unit-aware resolution is accepted (the pack stays on the caller's pack branch)", () => {
    expect(() =>
      buildInvoiceUnitLine({
        item: { description: "x", qty: 1, unitPrice: 1 } as never,
        product,
        resolved: resolveLineUnits(product, units, { unitLabel: null }),
        category: null,
        tenantId: "t-1",
      }),
    ).toThrow(/unit-aware/);
  });
});
