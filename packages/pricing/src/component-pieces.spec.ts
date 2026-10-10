/**
 * #2717 M3 (SA-572 A2, SA-579 Q7) — allocateComponentPieces and componentSubLineText.
 *
 * A FIXED order line stores its components once (they sum to the line's pieces). An invoice
 * bills some of those pieces: a full bill copies the components verbatim, a partial bill splits
 * the pieces over what is still unbilled by largest remainder, so the bills telescope back to the
 * order components exactly. Expected values are hand-worked integers.
 */
import {
  allocateCentsLargestRemainder,
  allocateComponentPieces,
  componentSubLineText,
  MoneyInvariantError,
  roundMoney,
} from "./index";

const A = "prod-a";
const O = "prod-o";
const comps = (a: number, o: number) => [
  { componentProductId: A, qty: a },
  { componentProductId: O, qty: o },
];
const qtys = (xs: Array<{ qty: number }>) => xs.map((x) => x.qty);
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);

describe("allocateComponentPieces (cumulative, so partials telescope from a scalar prior)", () => {
  it("a full bill copies the components verbatim", () => {
    expect(allocateComponentPieces({ comps: comps(24, 24), prior: 0, bill: 48 })).toEqual(
      comps(24, 24),
    );
  });

  it("a whole-box partial is per-box x boxes: 1 of 2 boxes of 12+12 -> 12 + 12", () => {
    const out = allocateComponentPieces({ comps: comps(24, 24), prior: 0, bill: 24 });
    expect(qtys(out)).toEqual([12, 12]);
  });

  it("uneven recipe: 1 of 2 boxes of 8+4 -> 8 + 4 per box", () => {
    const out = allocateComponentPieces({ comps: comps(16, 8), prior: 0, bill: 12 });
    expect(qtys(out)).toEqual([8, 4]);
  });

  it("47 of 48 uses largest remainder and sums to 47 (tie: weight desc, index asc)", () => {
    const out = allocateComponentPieces({ comps: comps(24, 24), prior: 0, bill: 47 });
    expect(qtys(out)).toEqual([24, 23]);
  });

  it("a zero bill is all zeros and keeps every component row", () => {
    expect(allocateComponentPieces({ comps: comps(24, 24), prior: 5, bill: 0 })).toEqual(
      comps(0, 0),
    );
  });

  it("the telescoped sum over partial bills equals the order components", () => {
    const order = comps(30, 18);
    let prior = 0;
    const totals = [0, 0];
    for (const bill of [10, 13, 5, 20]) {
      const out = allocateComponentPieces({ comps: order, prior, bill });
      out.forEach((c, i) => (totals[i] += c.qty));
      prior += bill;
    }
    expect(totals).toEqual([30, 18]);
  });

  it("refuses a bill past the order pieces and fractional or negative pieces", () => {
    for (const bad of [
      { prior: 10, bill: 39 },
      { prior: 0, bill: 1.5 },
      { prior: -1, bill: 1 },
      { prior: 0, bill: -1 },
    ]) {
      expect(() => allocateComponentPieces({ comps: comps(24, 24), ...bad })).toThrow(
        MoneyInvariantError,
      );
    }
  });

  it("seeded sweep: never negative, never above the component, exact sums, totals telescope", () => {
    const rnd = mulberry32(2717);
    for (let run = 0; run < 300; run++) {
      const n = 1 + Math.floor(rnd() * 4);
      const order = Array.from({ length: n }, (_, i) => ({
        componentProductId: `p${i}`,
        qty: 1 + Math.floor(rnd() * 30),
      }));
      const total = sum(order.map((c) => c.qty));
      const billedSoFar = order.map(() => 0);
      let prior = 0;
      while (prior < total) {
        const left = total - prior;
        const bill = rnd() < 0.3 ? left : 1 + Math.floor(rnd() * left);
        const out = allocateComponentPieces({ comps: order, prior, bill });
        expect(sum(qtys(out))).toBe(bill);
        out.forEach((c, i) => {
          expect(c.qty).toBeGreaterThanOrEqual(0);
          billedSoFar[i] += c.qty;
          expect(billedSoFar[i]).toBeLessThanOrEqual(order[i].qty);
        });
        prior += bill;
      }
      expect(billedSoFar).toEqual(order.map((c) => c.qty));
    }
  });
});

describe("largest-remainder caller condition (lead condition 2)", () => {
  it("an unrounded float sum is refused; rounded at the call site it splits whole cents", () => {
    const unrounded = 0.1 + 0.2; // 0.30000000000000004
    expect(() => allocateCentsLargestRemainder(unrounded, [1, 1, 1])).toThrow();
    expect(allocateCentsLargestRemainder(roundMoney(unrounded), [1, 1, 1])).toEqual([
      0.1, 0.1, 0.1,
    ]);
  });
});

describe("componentSubLineText (the one shared sub-line text, L-225)", () => {
  it("name, pieces, sku, barcode and the frozen price, price shown from the stored 4dp", () => {
    expect(
      componentSubLineText({
        name: "Almond",
        qty: 24,
        unitSku: "ALM-1",
        unitBarcode: "012345678905",
        displayUnitPrice4: 0.625,
      }),
    ).toBe("Almond x 24 | SKU ALM-1 | 012345678905 | $0.63 (included)");
  });

  it("no price prints just (included); no sku or barcode drops those parts", () => {
    expect(
      componentSubLineText({
        name: "Oat",
        qty: 1,
        unitSku: null,
        unitBarcode: null,
        displayUnitPrice4: null,
      }),
    ).toBe("Oat x 1 | (included)");
  });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
