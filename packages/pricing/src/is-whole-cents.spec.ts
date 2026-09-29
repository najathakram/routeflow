import { isWholeCents } from "./index";

describe("isWholeCents (#2695, SA-557c)", () => {
  it("accepts EVERY cent value from $0.00 to $100.00 (executed, not sampled)", () => {
    const refused: number[] = [];
    for (let cents = 0; cents <= 10000; cents++) {
      if (!isWholeCents(cents / 100)) refused.push(cents / 100);
    }
    expect(refused).toEqual([]);
    // the float-unsafe spellings a hand-rolled check trips on
    for (const n of [19.99, 1.1, 4.35, 0.07, 2.3, 0.29]) expect(isWholeCents(n)).toBe(true);
  });

  it("refuses sub-cent and non-finite values", () => {
    for (const n of [1.005, 19.999, 0.001, 0.015, NaN, Infinity, -Infinity]) {
      expect(isWholeCents(n)).toBe(false);
    }
  });

  it("is sign-agnostic: -0.01 is whole cents (a caller needing >= 0 checks that itself)", () => {
    expect(isWholeCents(-0.01)).toBe(true);
    expect(isWholeCents(-1.005)).toBe(false);
  });
});
