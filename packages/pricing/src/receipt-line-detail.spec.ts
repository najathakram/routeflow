import { formatReceiptMoney, priceUnitWord, receiptLineDetail } from "./receipt-line-detail";

/**
 * Row 317b: the ONE text of a receipt line's detail ("3 × $2.50 each"). The live counter receipt, the Today's-sales reprint
 * and the emailed receipt all print it from here, so the unit word can never differ between them.
 */
describe("priceUnitWord", () => {
  it("is the unit the operator chose, lower-cased, else 'unit'", () => {
    expect(priceUnitWord("Each")).toBe("each");
    expect(priceUnitWord("  LB ")).toBe("lb");
    expect(priceUnitWord(null)).toBe("unit");
    expect(priceUnitWord("   ")).toBe("unit");
  });
});

describe("formatReceiptMoney", () => {
  it("puts the sign first", () => {
    expect(formatReceiptMoney(2.5)).toBe("$2.50");
    expect(formatReceiptMoney(-1)).toBe("-$1.00");
  });
});

describe("receiptLineDetail", () => {
  it("a plain line prints qty x price and the product's own unit word", () => {
    expect(receiptLineDetail({ unitPrice: 2.5, qty: 3, unit: "Each" })).toBe("3 × $2.50 each");
    expect(receiptLineDetail({ unitPrice: 4, qty: 1.5, unit: "lb" })).toBe("1.5 × $4.00 per lb");
  });

  it("a plain line with no unit prints no word", () => {
    expect(receiptLineDetail({ unitPrice: 4, qty: 1 })).toBe("1 × $4.00");
    expect(receiptLineDetail({ unitPrice: 4, qty: 1, unit: "  " })).toBe("1 × $4.00");
  });

  it("a boxed line prints boxes + pieces x the BOX price (no unit word)", () => {
    expect(
      receiptLineDetail({
        unitPrice: 12,
        qty: 15,
        unitsPerBox: 12,
        boxes: 1,
        pieces: 3,
        unit: "each",
      }),
    ).toBe("1 box + 3 pcs × $12.00 per box");
    expect(
      receiptLineDetail({ unitPrice: 12, qty: 24, unitsPerBox: 12, boxes: 2, pieces: 0 }),
    ).toBe("2 boxes × $12.00 per box");
  });

  it("a pack size of 1 is not boxed", () => {
    expect(receiptLineDetail({ unitPrice: 2, qty: 2, unitsPerBox: 1, unit: "case" })).toBe(
      "2 × $2.00 per case",
    );
  });
});
