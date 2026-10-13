import { fromCents, toCents } from "./cents";

describe("toCents / fromCents (SA-733 D9: the one Stripe-amount helper)", () => {
  it("scales a dollar price to whole cents", () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(50)).toBe(5000);
    expect(toCents(0)).toBe(0);
    expect(toCents(249)).toBe(24900);
  });

  it("float noise never moves a cent: 0.1 + 0.2 is 30, 12.345 is 1235, 1.005 is 101", () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(12.345)).toBe(1235);
    // the bare `Math.round(1.005 * 100)` is 100 (1.005 * 100 = 100.49999999999999)
    expect(Math.round(1.005 * 100)).toBe(100);
    expect(toCents(1.005)).toBe(101);
  });

  it("accepts a numeric string (a Decimal read as text)", () => {
    expect(toCents("19.00")).toBe(1900);
    expect(toCents(" 7.5 ")).toBe(750);
  });

  it("refuses what is not a real price instead of billing $0", () => {
    expect(() => toCents(NaN)).toThrow(RangeError);
    expect(() => toCents(Infinity)).toThrow(RangeError);
    expect(() => toCents("")).toThrow(RangeError);
    expect(() => toCents("abc")).toThrow(RangeError);
    expect(() => toCents(-1)).toThrow(RangeError);
    expect(() => toCents(-0.01)).toThrow(RangeError);
    expect(() => toCents(undefined as unknown as number)).toThrow(RangeError);
  });

  it("fromCents turns whole cents back into a rounded dollar figure; a fraction or NaN throws", () => {
    expect(fromCents(1999)).toBe(19.99);
    expect(fromCents(0)).toBe(0);
    expect(fromCents(-500)).toBe(-5); // a credit line is allowed
    expect(() => fromCents(10.5)).toThrow(RangeError);
    expect(() => fromCents(NaN)).toThrow(RangeError);
  });

  it("round-trips every whole-cent amount in $0-$100", () => {
    for (let c = 0; c <= 10_000; c++) expect(toCents(fromCents(c))).toBe(c);
  });
});
