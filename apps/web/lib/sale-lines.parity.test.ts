import { cartTotals } from "./counter-sale";
import { orderBuilderTotals } from "./order-builder-totals";
import { saleLinesOf } from "./sale-lines";

/**
 * W-858: the till (`cartTotals`) and the order builder (`orderBuilderTotals`) read ONE figure for the same lines, so a sale
 * keyed on either screen shows what the server writes. These rows are the cross-screen agreement the shared mapping gives.
 */
const CATS = new Map([
  ["crv", { id: "crv", name: "CRV deposit", taxType: "EXCISE_PER_UNIT", rate: "0.05" }],
  [
    "exc",
    { id: "exc", name: "Excise", taxType: "PERCENT_OF_SALE", rate: "0.1", priceIncludesTax: true },
  ],
]);
const LINES = [
  { unitPrice: 2, qty: 10, trackedCategoryId: "crv" },
  { unitPrice: 24, qty: 30, boxes: 1, pieces: 6, unitsPerBox: 24 },
  { unitPrice: 9.99, qty: 3, trackedCategoryId: "exc" },
  { unitPrice: 1.15, qty: 7 },
];

describe("the till and the order builder total the same lines to the same cent (W-858)", () => {
  it.each([
    ["8.25% tax", 8.25, false],
    ["no tax rate on file", 0, false],
    ["a tax-exempt customer", 8.25, true],
  ])("%s", (_name, ratePct, isTaxExempt) => {
    const till = cartTotals(LINES, ratePct / 100, { isTaxExempt, categories: CATS });
    const builder = orderBuilderTotals(LINES, {
      taxRatePct: ratePct,
      isTaxExempt,
      categoryById: CATS,
    });
    expect(builder).toEqual(
      expect.objectContaining({
        subtotal: till.subtotal,
        tax: till.tax,
        charges: till.charges,
        total: till.total,
        chargeLines: till.chargeLines,
      }),
    );
  });

  it("an uncategorised line, or one whose category is absent from the map, carries no levy", () => {
    const [plain, orphan] = saleLinesOf(
      [
        { unitPrice: 5, qty: 1 },
        { unitPrice: 5, qty: 1, trackedCategoryId: "gone" },
      ],
      CATS,
    );
    expect(plain.category).toBeNull();
    expect(orphan.category).toBeNull();
  });

  it("a Decimal-string category rate becomes a number and priceIncludesTax defaults to false", () => {
    const [l] = saleLinesOf([{ unitPrice: 2, qty: 10, trackedCategoryId: "crv" }], CATS);
    expect(l.category).toEqual({
      id: "crv",
      name: "CRV deposit",
      taxType: "EXCISE_PER_UNIT",
      rate: 0.05,
      priceIncludesTax: false,
    });
  });
});
