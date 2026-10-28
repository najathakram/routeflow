import { roundMoney } from "./pricing";
import { scaleFrozenSplit } from "./scale-frozen-split";

const sum = (s: { net: number; tax: number; categoryTax: number }) =>
  roundMoney(s.net + s.tax + s.categoryTax);

describe("scaleFrozenSplit (SA-980: a reduced hold approval re-freezes the split pro rata)", () => {
  it("10.80 (10.00 net + 0.80 tax) approved at 5.40 -> 5.00 / 0.40 / 0", () => {
    expect(scaleFrozenSplit({ net: 10, tax: 0.8, categoryTax: 0 }, 5.4)).toEqual({
      net: 5,
      tax: 0.4,
      categoryTax: 0,
    });
  });

  it("with a category tax: 10.00 / 0.80 / 0.50 (11.30) approved at 5.65 -> 5.00 / 0.40 / 0.25", () => {
    expect(scaleFrozenSplit({ net: 10, tax: 0.8, categoryTax: 0.5 }, 5.65)).toEqual({
      net: 5,
      tax: 0.4,
      categoryTax: 0.25,
    });
  });

  it("the full frozen gross returns the same split untouched", () => {
    expect(scaleFrozenSplit({ net: 10, tax: 0.8, categoryTax: 0.5 }, 11.3)).toEqual({
      net: 10,
      tax: 0.8,
      categoryTax: 0.5,
    });
  });

  it("odd-cent case: 10.80 approved at 3.33 sums to 3.33 to the cent", () => {
    const s = scaleFrozenSplit({ net: 10, tax: 0.8, categoryTax: 0 }, 3.33);
    expect(s).toEqual({ net: 3.08, tax: 0.25, categoryTax: 0 });
    expect(sum(s)).toBe(3.33);
  });

  it("the three parts always sum to approvedGross after roundMoney", () => {
    const frozen = { net: 17.43, tax: 1.39, categoryTax: 0.67 };
    for (let cents = 1; cents <= 1949; cents += 7) {
      const approved = cents / 100;
      const s = scaleFrozenSplit(frozen, approved);
      expect(sum(s)).toBe(roundMoney(approved));
    }
  });

  it("a zero frozen gross has nothing to scale: net carries the approved amount", () => {
    expect(scaleFrozenSplit({ net: 0, tax: 0, categoryTax: 0 }, 4)).toEqual({
      net: 4,
      tax: 0,
      categoryTax: 0,
    });
  });
});
