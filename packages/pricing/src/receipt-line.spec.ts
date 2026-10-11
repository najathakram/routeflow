import { receiptLineAmounts } from "./receipt-line";
import { showOriginalPrice } from "./show-original-price";

describe("showOriginalPrice (the invoices' rule, shared with the receipts)", () => {
  it("strikes a stored original price for SPECIAL, DISCOUNTED, PROMO and an adjusted line", () => {
    for (const priceType of ["SPECIAL", "DISCOUNTED", "PROMO", "STANDARD"])
      expect(showOriginalPrice({ originalPrice: 12, unitPrice: 10, priceType }, false)).toBe(true);
  });
  it("never when the tenant hides original prices, or when there is none", () => {
    expect(
      showOriginalPrice({ originalPrice: 12, unitPrice: 10, priceType: "SPECIAL" }, true),
    ).toBe(false);
    expect(showOriginalPrice({ originalPrice: null, unitPrice: 10 }, false)).toBe(false);
    expect(showOriginalPrice({ unitPrice: 10 }, false)).toBe(false);
  });
  it("never exposes the lower base of a MANUAL upsell (charged above the original)", () => {
    expect(
      showOriginalPrice({ originalPrice: 12, unitPrice: 14, priceType: "MANUAL" }, false),
    ).toBe(false);
    expect(
      showOriginalPrice({ originalPrice: "12.00", unitPrice: "14.00", priceType: "MANUAL" }, false),
    ).toBe(false);
    expect(
      showOriginalPrice({ originalPrice: 12, unitPrice: 10, priceType: "MANUAL" }, false),
    ).toBe(true);
  });
});

describe("receiptLineAmounts (the one rule for a lowered price on a receipt)", () => {
  it("the proof line: 2 x $10.00 rung off a $14.99 list shows $20.00, struck $29.98, discount $9.98", () => {
    expect(
      receiptLineAmounts({ unitPrice: 10, originalPrice: 14.99, priceType: "DISCOUNTED", qty: 2 }),
    ).toEqual({ total: 20, original: 29.98, discount: 9.98 });
  });
  it("an unedited special-tier line is struck from the LIST price like an invoice", () => {
    expect(
      receiptLineAmounts({ unitPrice: 10, originalPrice: "12.00", priceType: "SPECIAL", qty: 2 }),
    ).toEqual({ total: 20, original: 24, discount: 4 });
  });
  it("no list price, or one that is not above the charge, prints plain (a raised price never reveals the lower figure)", () => {
    expect(receiptLineAmounts({ unitPrice: 2.5, qty: 1 })).toEqual({
      total: 2.5,
      original: null,
      discount: 0,
    });
    expect(receiptLineAmounts({ unitPrice: 2.5, originalPrice: null, qty: 1 }).original).toBeNull();
    expect(receiptLineAmounts({ unitPrice: 4, originalPrice: 4, qty: 3 }).original).toBeNull();
    expect(
      receiptLineAmounts({ unitPrice: 6, originalPrice: 5, priceType: "STANDARD", qty: 3 }),
    ).toEqual({ total: 18, original: null, discount: 0 });
  });
  it("a MANUAL upsell never shows its base, and hideOriginalPrice shows nothing at all", () => {
    expect(
      receiptLineAmounts({ unitPrice: 14, originalPrice: 12, priceType: "MANUAL", qty: 1 })
        .original,
    ).toBeNull();
    expect(
      receiptLineAmounts({
        unitPrice: 8,
        originalPrice: 12,
        priceType: "DISCOUNTED",
        qty: 2,
        hideOriginalPrice: true,
      }),
    ).toEqual({ total: 16, original: null, discount: 0 });
  });
  it("a boxed line is prorated at both prices (never qty x price)", () => {
    expect(
      receiptLineAmounts({
        unitPrice: 12,
        originalPrice: 15,
        priceType: "DISCOUNTED",
        qty: 15,
        boxes: 1,
        pieces: 3,
        unitsPerBox: 12,
      }),
    ).toEqual({ total: 15, original: 18.75, discount: 3.75 });
  });
});
