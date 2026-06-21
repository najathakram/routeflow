/**
 * Mobile pricing mirror must agree with the server (apps/api/src/common/pricing.ts)
 * so the operator sees exactly the number the API will store — including the
 * money-rounding fix (220 x 2 = 440, never 420 / 16.467…).
 */
import { computeLineSubtotal, roundMoney, normalizeBoxesPieces } from "../lib/pricing";

describe("roundMoney (mobile mirror)", () => {
  it("rounds to cents", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(14.97 * 1.1)).toBe(16.47);
  });
});

describe("computeLineSubtotal (mobile mirror)", () => {
  it("220 x 2 = 440", () => {
    expect(computeLineSubtotal({ unitPrice: 220, qty: 2 })).toBe(440);
  });

  it("bills boxed products per box", () => {
    expect(
      computeLineSubtotal({ unitPrice: 220, qty: 22, boxes: 2, pieces: 0, unitsPerBox: 11 }),
    ).toBe(440);
  });

  it("prorates loose pieces", () => {
    expect(
      computeLineSubtotal({ unitPrice: 220, qty: 21, boxes: 1, pieces: 10, unitsPerBox: 11 }),
    ).toBe(420);
  });
});

describe("normalizeBoxesPieces (mobile mirror)", () => {
  it("rolls full boxes and forces integers", () => {
    expect(normalizeBoxesPieces({ boxes: 1, pieces: 11, unitsPerBox: 11 })).toEqual({
      boxes: 2,
      pieces: 0,
      qty: 22,
    });
    expect(normalizeBoxesPieces({ qty: 2.7, unitsPerBox: 1 })).toEqual({
      boxes: null,
      pieces: null,
      qty: 2,
    });
  });
});
