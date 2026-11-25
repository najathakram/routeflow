import { farFromListText } from "./far-from-list";

describe("farFromListText", () => {
  it("3.00 on a $6.99 line is 57% below list", () => {
    expect(farFromListText(3, 6.99)).toBe("57% below list ($6.99)");
  });

  it("60 typed for a $6.00 line is 900% above list", () => {
    expect(farFromListText(60, 6)).toBe("900% above list ($6.00)");
  });

  it("says nothing at exactly half and exactly double, and anywhere between", () => {
    expect(farFromListText(5, 10)).toBeNull();
    expect(farFromListText(20, 10)).toBeNull();
    expect(farFromListText(9.5, 10)).toBeNull();
    expect(farFromListText(12, 10)).toBeNull();
  });

  it("speaks one cent outside the band on either side", () => {
    expect(farFromListText(4.99, 10)).toBe("50% below list ($10.00)");
    expect(farFromListText(20.01, 10)).toBe("100% above list ($10.00)");
  });

  it("a free line (0.00) on a priced product is 100% below list", () => {
    expect(farFromListText(0, 10)).toBe("100% below list ($10.00)");
  });

  it("says nothing with no list price to compare with, or a price that is not a real amount", () => {
    expect(farFromListText(5, 0)).toBeNull();
    expect(farFromListText(5, Number.NaN)).toBeNull();
    expect(farFromListText(-1, 10)).toBeNull();
    expect(farFromListText(Number.NaN, 10)).toBeNull();
  });
});
