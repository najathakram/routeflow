import { creditedThrough, prorateLineSubtotal } from "./pricing";

/**
 * B894 (SA-576): the SLICE rule for an already-billed line is LINEAR — roundMoney(S × min(c, P) / P) —
 * additive, monotone, never negative, and equal to `prorateLineSubtotal(S, c, P)` at free = 0.
 * (iv) characterizes the INVOICE's delivered-basis curve, which B894 does NOT change (B895 owns it).
 */
describe("creditedThrough", () => {
  it("(ii) monotone non-decreasing in c, within [0, S], the whole line at c >= P and 0 at c <= 0", () => {
    for (const [S, P] of [
      [24, 20],
      [10, 2],
      [100, 7],
      [0.05, 3],
    ]) {
      let prev = 0;
      for (let c = 0; c <= P; c++) {
        const v = creditedThrough(S, c, P);
        expect(v).toBeGreaterThanOrEqual(prev);
        expect(v).toBeLessThanOrEqual(S);
        prev = v;
      }
      expect(creditedThrough(S, P, P)).toBe(S);
      expect(creditedThrough(S, P + 5, P)).toBe(S);
      expect(creditedThrough(S, 0, P)).toBe(0);
      expect(creditedThrough(S, -3, P)).toBe(0);
    }
  });

  it("degenerate inputs are 0, never NaN", () => {
    expect(creditedThrough(24, 5, 0)).toBe(0);
    expect(creditedThrough(null, 5, 10)).toBe(0);
    expect(creditedThrough(undefined, 5, 10)).toBe(0);
    expect(creditedThrough(24, NaN, 10)).toBe(0);
  });

  it("additive: any chunking sums to the whole up to half a cent per chunk", () => {
    for (const chunks of [[9, 9, 2], [1, 19], [7, 7, 6], [20]]) {
      const total = chunks.reduce((a, b) => a + creditedThrough(24, b, 20), 0);
      expect(Math.abs(total - 24)).toBeLessThanOrEqual(0.005 * chunks.length + 1e-9);
    }
  });

  it("(iii) parity: equals prorateLineSubtotal at free = 0", () => {
    for (const [S, P] of [
      [24, 20],
      [10, 2],
      [99.99, 7],
    ])
      for (let c = 0; c <= P; c++)
        expect(creditedThrough(S, c, P)).toBe(prorateLineSubtotal(S, c, P, 0, 1));
  });
});

describe("(iv) CHARACTERIZATION — the invoice's delivered-basis bill is non-monotone (B895)", () => {
  it("S=24, 20 pcs, 2 free boxes of 4: 9 pieces bill 18.00 but 10 pieces bill 12.00 — flips when B895's fix lands", () => {
    expect(prorateLineSubtotal(24, 9, 20, 2, 4)).toBe(18);
    expect(prorateLineSubtotal(24, 10, 20, 2, 4)).toBe(12);
  });
});
