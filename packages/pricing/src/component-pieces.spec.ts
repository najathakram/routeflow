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
} from "./index";

const A = "prod-a";
const O = "prod-o";
const comps = (a: number, o: number) => [
  { componentProductId: A, qty: a },
  { componentProductId: O, qty: o },
];
const qtys = (xs: Array<{ qty: number }>) => xs.map((x) => x.qty);
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);

describe("allocateComponentPieces", () => {
  it("a full bill copies the components verbatim", () => {
    const out = allocateComponentPieces({ comps: comps(24, 24), billed: [0, 0], bill: 48 });
    expect(out).toEqual(comps(24, 24));
  });

  it("a whole-box partial is per-box x boxes: 1 of 2 boxes of 12+12 -> 12 + 12", () => {
    const out = allocateComponentPieces({ comps: comps(24, 24), billed: [0, 0], bill: 24 });
    expect(qtys(out)).toEqual([12, 12]);
  });

  it("47 of 48 uses largest remainder and sums to 47 (tie: weight desc, index asc)", () => {
    const out = allocateComponentPieces({ comps: comps(24, 24), billed: [0, 0], bill: 47 });
    expect(qtys(out)).toEqual([24, 23]);
    expect(sum(qtys(out))).toBe(47);
  });

  it("a zero bill is all zeros and keeps every component row", () => {
    const out = allocateComponentPieces({ comps: comps(24, 24), billed: [0, 0], bill: 0 });
    expect(out).toEqual(comps(0, 0));
  });

  it("the telescoped sum over partial bills equals the order components", () => {
    const order = comps(30, 18);
    const billed = [0, 0];
    const parts: number[][] = [];
    for (const bill of [10, 13, 5, 20]) {
      const out = allocateComponentPieces({ comps: order, billed, bill });
      parts.push(qtys(out));
      out.forEach((c, i) => (billed[i] += c.qty));
    }
    expect([parts.reduce((a, p) => a + p[0], 0), parts.reduce((a, p) => a + p[1], 0)]).toEqual([
      30, 18,
    ]);
  });

  it("refuses a bill above what is unbilled, a fractional bill and mismatched billed", () => {
    expect(() =>
      allocateComponentPieces({ comps: comps(24, 24), billed: [10, 0], bill: 39 }),
    ).toThrow(MoneyInvariantError);
    expect(() =>
      allocateComponentPieces({ comps: comps(24, 24), billed: [0, 0], bill: 1.5 }),
    ).toThrow(MoneyInvariantError);
    expect(() => allocateComponentPieces({ comps: comps(24, 24), billed: [0], bill: 1 })).toThrow(
      MoneyInvariantError,
    );
  });

  it("seeded sweep: never negative, never above unbilled, each bill sums exactly, totals telescope", () => {
    const rnd = mulberry32(2717);
    for (let run = 0; run < 300; run++) {
      const n = 1 + Math.floor(rnd() * 4);
      const order = Array.from({ length: n }, (_, i) => ({
        componentProductId: `p${i}`,
        qty: 1 + Math.floor(rnd() * 30),
      }));
      const total = sum(order.map((c) => c.qty));
      const billed = order.map(() => 0);
      let left = total;
      while (left > 0) {
        const bill = rnd() < 0.3 ? left : 1 + Math.floor(rnd() * left);
        const out = allocateComponentPieces({ comps: order, billed, bill });
        expect(sum(qtys(out))).toBe(bill);
        out.forEach((c, i) => {
          expect(c.qty).toBeGreaterThanOrEqual(0);
          expect(c.qty).toBeLessThanOrEqual(order[i].qty - billed[i]);
          billed[i] += c.qty;
        });
        left -= bill;
      }
      expect(billed).toEqual(order.map((c) => c.qty));
    }
  });
});

describe("largest-remainder caller condition (lead condition 2)", () => {
  it("an unrounded float sum through the allocator does not throw and stays whole cents", () => {
    const unrounded = 0.1 + 0.2; // 0.30000000000000004
    expect(() => allocateCentsLargestRemainder(unrounded, [1, 1, 1])).not.toThrow();
    expect(allocateCentsLargestRemainder(unrounded, [1, 1, 1])).toEqual([0.1, 0.1, 0.1]);
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
