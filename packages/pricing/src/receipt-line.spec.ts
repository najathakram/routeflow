import { receiptLineAmounts } from "./receipt-line";

describe("receiptLineAmounts (the one rule for a lowered price on a receipt)", () => {
  it("the proof line: 2 x $10.00 rung off a $14.99 list shows $20.00, struck $29.98, discount $9.98", () => {
    expect(receiptLineAmounts({ unitPrice: 10, listUnitPrice: 14.99, qty: 2 })).toEqual({
      total: 20,
      original: 29.98,
      discount: 9.98,
    });
  });
  it("no list price, or one that is not above the charge, prints plain (a raised price never reveals the lower figure)", () => {
    expect(receiptLineAmounts({ unitPrice: 2.5, qty: 1 })).toEqual({
      total: 2.5,
      original: null,
      discount: 0,
    });
    expect(receiptLineAmounts({ unitPrice: 2.5, listUnitPrice: null, qty: 1 })).toEqual({
      total: 2.5,
      original: null,
      discount: 0,
    });
    expect(receiptLineAmounts({ unitPrice: 4, listUnitPrice: 4, qty: 3 }).original).toBeNull();
    expect(receiptLineAmounts({ unitPrice: 6, listUnitPrice: 5, qty: 3 })).toEqual({
      total: 18,
      original: null,
      discount: 0,
    });
  });
  it("a boxed line is prorated at both prices (never qty x price)", () => {
    expect(
      receiptLineAmounts({
        unitPrice: 12,
        listUnitPrice: 15,
        qty: 15,
        boxes: 1,
        pieces: 3,
        unitsPerBox: 12,
      }),
    ).toEqual({ total: 15, original: 18.75, discount: 3.75 });
  });
});
