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
    expect(receiptLineDetail({ unitPrice: 2.5, qty: 3, unit: "Each", unitLabel: null })).toBe(
      "3 × $2.50 each",
    );
    expect(receiptLineDetail({ unitPrice: 4, qty: 1.5, unit: "lb", unitLabel: null })).toBe(
      "1.5 × $4.00 per lb",
    );
  });

  it("a plain line with no unit prints no word", () => {
    expect(receiptLineDetail({ unitPrice: 4, qty: 1, unitLabel: null })).toBe("1 × $4.00");
    expect(receiptLineDetail({ unitPrice: 4, qty: 1, unit: "  ", unitLabel: null })).toBe(
      "1 × $4.00",
    );
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
        unitLabel: null,
      }),
    ).toBe("1 box + 3 pcs × $12.00 per box");
    expect(
      receiptLineDetail({
        unitPrice: 12,
        qty: 24,
        unitsPerBox: 12,
        boxes: 2,
        pieces: 0,
        unitLabel: null,
      }),
    ).toBe("2 boxes × $12.00 per box");
  });

  it("a pack size of 1 is not boxed", () => {
    expect(
      receiptLineDetail({ unitPrice: 2, qty: 2, unitsPerBox: 1, unit: "case", unitLabel: null }),
    ).toBe("2 × $2.00 per case");
  });

  // SA-1040 B4a (R-c1): a unit line names its own unit; master printed "2 boxes × $45.00 per box" for a Case line
  it("a unit line prints its count and its own unit word at the unit price", () => {
    const caseLine = { unitPrice: 45, qty: 400, unitsPerBox: 200, boxes: 2, pieces: 0 };
    expect(receiptLineDetail({ ...caseLine, unitLabel: "Case" })).toBe("2 Cases × $45.00 per Case");
    expect(receiptLineDetail({ ...caseLine, boxes: 1, qty: 200, unitLabel: "Case" })).toBe(
      "1 Case × $45.00 per Case",
    );
    expect(
      receiptLineDetail({
        ...caseLine,
        boxes: 1,
        qty: 4800,
        unitsPerBox: 4800,
        unitLabel: "Pallet",
      }),
    ).toBe("1 Pallet × $45.00 per Pallet");
  });

  it("a unit line with no stored boxes (a live till line) counts by qty; a blank unit is a pack line", () => {
    expect(receiptLineDetail({ unitPrice: 1.4, qty: 3, unitLabel: "Piece" })).toBe(
      "3 Pieces × $1.40 per Piece",
    );
    expect(
      receiptLineDetail({ unitPrice: 12, qty: 24, unitsPerBox: 12, boxes: 2, unitLabel: "  " }),
    ).toBe("2 boxes × $12.00 per box");
  });
});

describe("formatReceiptMoney: US grouping like the Orders list (CQ-19)", () => {
  it.each([
    [2097, "$2,097.00"],
    [2270, "$2,270.00"],
    [2431.44, "$2,431.44"],
    [1234567.5, "$1,234,567.50"],
    [999.99, "$999.99"],
    [0, "$0.00"],
    [-1234.5, "-$1,234.50"],
    [-1, "-$1.00"],
  ])("%s -> %s", (n, text) => {
    expect(formatReceiptMoney(n)).toBe(text);
  });
});
