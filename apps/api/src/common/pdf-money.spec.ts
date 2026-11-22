import { fmtPdfMoney } from "./pdf-money";

/** SA-1211 BF-7: the ONE document money text. Grouped, two decimals, rounded through roundMoney first. */
describe("fmtPdfMoney", () => {
  it("groups thousands: 5500 -> $5,500.00 (red on $5500.00)", () => {
    expect(fmtPdfMoney(5500)).toBe("$5,500.00");
  });

  it("rounds through roundMoney first: 1234567.891 -> $1,234,567.89", () => {
    expect(fmtPdfMoney(1234567.891)).toBe("$1,234,567.89");
  });

  it("rounds half cents the money way, not the float way: 1.005 -> $1.01", () => {
    expect(fmtPdfMoney(1.005)).toBe("$1.01");
  });

  it("prints a negative with the sign before the dollar sign: -1234.5 -> -$1,234.50", () => {
    expect(fmtPdfMoney(-1234.5)).toBe("-$1,234.50");
  });

  it("prints zero, and a negative that rounds to zero, without a sign", () => {
    expect(fmtPdfMoney(0)).toBe("$0.00");
    expect(fmtPdfMoney(-0.001)).toBe("$0.00");
  });

  it("small amounts keep two decimals", () => {
    expect(fmtPdfMoney(9.5)).toBe("$9.50");
  });
});
