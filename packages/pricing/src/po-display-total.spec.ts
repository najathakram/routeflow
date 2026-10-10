import { poDisplayTotal, storedPOLineTotal } from "./po-display-total";

/**
 * #1485 / B719 + the lead's condition on #2637: ONE purchase-order total rule, imported by web and
 * mobile. The stored order total wins (coerced + rounded); otherwise the lines' stored totals.
 */
const line = (
  totalCost: string | number | null | undefined,
  qtyOrdered = "1",
  unitCost = "1.0000",
) => ({
  qtyOrdered,
  unitCost,
  totalCost,
});

describe("storedPOLineTotal", () => {
  it("uses the stored exact line total, rounded to cents", () => {
    expect(storedPOLineTotal(line("11000.00", "12000", "0.9167"))).toBe(11000);
    expect(storedPOLineTotal(line("10.005"))).toBe(10.01);
  });
  it("never re-multiplies a line that has a stored total (B698: 12000 x 0.9167 = 11000.40)", () => {
    expect(storedPOLineTotal(line("11000.00", "12000", "0.9167"))).not.toBe(11000.4);
  });
  it.each([null, undefined, "", "abc", "-1"])(
    "no usable stored total (%j) ⇒ roundMoney(qty x unitCost)",
    (t) => {
      expect(storedPOLineTotal(line(t as any, "3", "10.0000"))).toBe(30);
    },
  );
  it("garbage qty/cost ⇒ 0, never NaN", () => {
    expect(storedPOLineTotal(line(null, "x", "y"))).toBe(0);
  });
});

describe("poDisplayTotal", () => {
  it.each([
    ["a numeric string (what the API sends)", "123.45", 123.45],
    ["a number", 88, 88],
    ["extra precision, rounded to cents (the old mobile copy returned it raw)", "10.005", 10.01],
  ])("the stored totalAmount as %s", (_label, totalAmount, want) => {
    expect(poDisplayTotal({ totalAmount, items: [line("999.00")] })).toBe(want);
  });

  it.each([null, undefined, "", "0", "0.00", "-5", "abc"])(
    "no usable stored total (%j) ⇒ the rounded sum of the lines' stored totals",
    (totalAmount) => {
      expect(
        poDisplayTotal({ totalAmount: totalAmount as any, items: [line("30.00"), line("12.50")] }),
      ).toBe(42.5);
    },
  );

  it("no stored total and no lines ⇒ 0", () => {
    expect(poDisplayTotal({ totalAmount: null, items: [] })).toBe(0);
    expect(poDisplayTotal({ totalAmount: null, items: null })).toBe(0);
    expect(poDisplayTotal({})).toBe(0);
  });

  it("sums many cent lines without float drift", () => {
    const items = Array.from({ length: 10 }, () => line("0.10"));
    expect(poDisplayTotal({ totalAmount: null, items })).toBe(1);
  });
});
