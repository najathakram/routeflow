/**
 * #2717 pre-M3 (SA-572 A1, SA-574 H1/H4/H5) — the mixed-pack component unit price.
 *
 * `componentUnitPrice4` is the stored 4-dp figure (round4 of net subtotal / pieces);
 * `displayComponentUnitPrice` is the 2-dp view, rounded from the STORED value. Expected
 * values are hand-worked decimals, never read out of an implementation.
 */
import {
  componentUnitPrice4,
  displayComponentUnitPrice,
  round4,
  roundMoney,
  roundUnitCost,
} from "./index";

describe("round4 (SA-574 H1: the one 4-dp body)", () => {
  it("rounds half away from zero at the 4th decimal", () => {
    expect(round4(1.23456)).toBe(1.2346);
    expect(round4(-0.00145)).toBe(-0.0015);
    expect(round4(2.13545)).toBe(2.1355);
  });

  it("non-finite input is 0", () => {
    expect(round4(NaN)).toBe(0);
    expect(round4(Infinity)).toBe(0);
    expect(round4(-Infinity)).toBe(0);
  });

  it("round4 === roundUnitCost at every point of -2..2 step 0.00001", () => {
    const diffs: number[] = [];
    for (let i = -200000; i <= 200000; i++) {
      const n = i / 100000;
      if (round4(n) !== roundUnitCost(n)) diffs.push(n);
    }
    expect(diffs).toEqual([]);
  });
});

describe("componentUnitPrice4 — money pins", () => {
  it("(a) 24-pack @ $30, 1 box + 16 pieces: 50.00 over 40 pieces = 1.25", () => {
    expect(componentUnitPrice4(50, 40)).toBe(1.25);
  });

  it("(b) 43.75 over 6 pieces = 7.2917", () => {
    expect(componentUnitPrice4(43.75, 6)).toBe(7.2917);
  });

  it("(c) NET basis: 2 boxes of 24 @ $30, one box free: 30.00 over 48 = 0.625 (list basis would be 1.25)", () => {
    expect(componentUnitPrice4(30, 48)).toBe(0.625);
  });

  it("(d) 24.99 over 200 = 0.125 (half at the 4th dp goes up)", () => {
    expect(componentUnitPrice4(24.99, 200)).toBe(0.125);
  });

  it("a zero subtotal is a real price of 0, not null", () => {
    expect(componentUnitPrice4(0, 12)).toBe(0);
  });
});

describe("componentUnitPrice4 — null domain (SA-574 H4)", () => {
  it.each([0, -1, NaN, Infinity, -Infinity])("pieces %p -> null", (pieces) => {
    expect(componentUnitPrice4(10, pieces)).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity, -0.01, -50])("subtotal %p -> null", (subtotal) => {
    expect(componentUnitPrice4(subtotal, 6)).toBeNull();
  });
});

describe("componentUnitPrice4 — precision sweep", () => {
  it("every cent subtotal 0..50.00 x pieces 1..60 is 4-dp and within half a 4th-dp unit", () => {
    const bad: string[] = [];
    for (let cents = 0; cents <= 5000; cents++) {
      const s = cents / 100;
      for (let n = 1; n <= 60; n++) {
        const r = componentUnitPrice4(s, n) as number;
        if (r === null || round4(r) !== r || Math.abs(r - s / n) > 0.00005 + 1e-12) {
          bad.push(`${s}/${n}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("displayComponentUnitPrice (SA-574 H5: round the STORED value)", () => {
  it("rounds the stored 4-dp value to cents", () => {
    expect(displayComponentUnitPrice(7.2917)).toBe(7.29);
    expect(displayComponentUnitPrice(0.625)).toBe(0.63);
  });

  it("24.99/200 shows 0.13 although roundMoney(24.99/200) is 0.12 (double rounding is intended)", () => {
    expect(displayComponentUnitPrice(componentUnitPrice4(24.99, 200) as number)).toBe(0.13);
    expect(roundMoney(24.99 / 200)).toBe(0.12);
  });

  it("I5 documentation pin: the sub-lines never sum (7.29 x 6 is 43.74, not 43.75)", () => {
    const shown = displayComponentUnitPrice(componentUnitPrice4(43.75, 6) as number);
    expect(roundMoney(shown * 6)).toBe(43.74);
  });
});
