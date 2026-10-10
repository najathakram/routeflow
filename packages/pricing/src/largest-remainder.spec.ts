/**
 * #2717 pre-M3 (SA-572 A2 / I7, SA-574 H2) — largest-remainder cent allocation and the
 * component credit telescope.
 *
 * H2 (SA-574 amendment): the cumulative basis is LINEAR, creditedThrough(c) = roundMoney(S*c/P)
 * over the STORED subtotal S. It is monotone, never negative, and sums to S at c = P. It is NOT
 * a running max of prorateLineSubtotal (which is non-monotone on free-unit lines; separate bug).
 * Expected values are hand-worked decimals.
 */
import {
  MoneyInvariantError,
  allocateCentsLargestRemainder,
  isWholeCents,
  prorateComponentCredit,
  prorateLineSubtotal,
  roundMoney,
} from "./index";

const cents = (n: number) => Math.round(n * 100);
const sumCents = (xs: number[]) => xs.reduce((a, x) => a + cents(x), 0);

describe("allocateCentsLargestRemainder", () => {
  it("10.00 over [1,1,1] -> [3.34, 3.33, 3.33] (per-part roundMoney would sum 9.99)", () => {
    expect(allocateCentsLargestRemainder(10, [1, 1, 1])).toEqual([3.34, 3.33, 3.33]);
  });

  it("7.00 over [10,7,7] -> [2.92, 2.04, 2.04]", () => {
    expect(allocateCentsLargestRemainder(7, [10, 7, 7])).toEqual([2.92, 2.04, 2.04]);
  });

  it("50.00 over [16,12,12] -> [20, 15, 15]", () => {
    expect(allocateCentsLargestRemainder(50, [16, 12, 12])).toEqual([20, 15, 15]);
  });

  it("tie-break is remainder desc, weight desc, index asc: 0.02 over [1,2,1] -> [0.01, 0.01, 0]", () => {
    expect(allocateCentsLargestRemainder(0.02, [1, 2, 1])).toEqual([0.01, 0.01, 0]);
  });

  it("the weight-desc key decides an equal-remainder tie: 0.02 over [1,3] -> [0, 0.02] (index-only order would give [0.01, 0.01])", () => {
    // 2 cents over weights 1 and 3: both remainders are 2 (of 4), floors 0 and 1, one cent left.
    // Weight desc hands it to the weight-3 part.
    expect(allocateCentsLargestRemainder(0.02, [1, 3])).toEqual([0, 0.02]);
  });

  it("total 0 -> zeros, even with all-zero weights", () => {
    expect(allocateCentsLargestRemainder(0, [3, 0, 2])).toEqual([0, 0, 0]);
    expect(allocateCentsLargestRemainder(0, [0, 0])).toEqual([0, 0]);
  });

  it("a zero-weight part gets nothing", () => {
    expect(allocateCentsLargestRemainder(1, [0, 1, 0])).toEqual([0, 1, 0]);
  });

  it("total > 0 with all-zero weights throws MoneyInvariantError", () => {
    expect(() => allocateCentsLargestRemainder(1, [0, 0])).toThrow(MoneyInvariantError);
    expect(() => allocateCentsLargestRemainder(1, [])).toThrow(MoneyInvariantError);
  });

  it.each([
    ["a sub-cent total (0.005: under one cent, not zero)", 0.005, [1, 1]],
    ["a sub-cent total (0.001)", 0.001, [1, 3]],
    ["a non-whole-cents total (10.005)", 10.005, [1, 1]],
    ["a non-whole-cents total (19.999)", 19.999, [2, 1]],
  ])("refuses %s rather than silently rounding it", (_label, total, weights) => {
    expect(() => allocateCentsLargestRemainder(total as number, weights as number[])).toThrow(
      MoneyInvariantError,
    );
  });

  it("whole-cent totals that are inexact in floats still pass (19.99, 1.10, 4.35, 0.07)", () => {
    for (const t of [19.99, 1.1, 4.35, 0.07]) {
      const parts = allocateCentsLargestRemainder(t, [1, 1, 1]);
      expect(sumCents(parts)).toBe(cents(t));
    }
  });

  it.each([
    ["negative total", -1, [1, 1]],
    ["NaN total", NaN, [1, 1]],
    ["Infinity total", Infinity, [1, 1]],
    ["negative weight", 1, [1, -1]],
    ["NaN weight", 1, [1, NaN]],
    ["Infinity weight", 1, [1, Infinity]],
    ["fractional weight", 1, [1.5, 1]],
  ])("refuses %s", (_label, total, weights) => {
    expect(() => allocateCentsLargestRemainder(total as number, weights as number[])).toThrow(
      MoneyInvariantError,
    );
  });
});

describe("prorateComponentCredit — telescope", () => {
  it("(a) S=10, P=6, six single-piece events sum to exactly 10.00 (per-event rounding gives 10.02)", () => {
    let prior = 0;
    let total = 0;
    for (let i = 0; i < 6; i++) {
      const r = prorateComponentCredit({
        storedSubtotal: 10,
        linePieces: 6,
        priorPieces: prior,
        parts: [1],
      });
      total += cents(r.total);
      prior += 1;
    }
    expect(total).toBe(1000);
    expect(roundMoney(prorateLineSubtotal(10, 1, 6) * 6)).toBe(10.02);
  });

  it("(b) S=50, P=40, [16,12,12] in one event -> [20, 15, 15]", () => {
    const r = prorateComponentCredit({
      storedSubtotal: 50,
      linePieces: 40,
      priorPieces: 0,
      parts: [16, 12, 12],
    });
    expect(r.total).toBe(50);
    expect(r.parts).toEqual([20, 15, 15]);
  });

  it("(c) S=7, P=24, prior 0, parts [5,0,1] -> total 1.75, parts [1.46, 0, 0.29]", () => {
    const r = prorateComponentCredit({
      storedSubtotal: 7,
      linePieces: 24,
      priorPieces: 0,
      parts: [5, 0, 1],
    });
    expect(r.total).toBe(1.75);
    expect(r.parts).toEqual([1.46, 0, 0.29]);
  });

  it("a zero-piece event credits nothing", () => {
    const r = prorateComponentCredit({
      storedSubtotal: 7,
      linePieces: 24,
      priorPieces: 3,
      parts: [0, 0],
    });
    expect(r).toEqual({ total: 0, parts: [0, 0] });
  });
});

describe("prorateComponentCredit — linear basis (SA-574 H2)", () => {
  it("S=24.00, P=20 (a free-unit line: 2 x 4): events 9 / 1 / 10 credit 10.80 / 1.20 / 12.00, never negative", () => {
    const events = [9, 1, 10];
    let prior = 0;
    const totals: number[] = [];
    for (const n of events) {
      totals.push(
        prorateComponentCredit({
          storedSubtotal: 24,
          linePieces: 20,
          priorPieces: prior,
          parts: [n],
        }).total,
      );
      prior += n;
    }
    expect(totals).toEqual([10.8, 1.2, 12]);
    expect(sumCents(totals)).toBe(2400);
  });

  it("parity: free = 0 and prior = 0 -> the event total equals prorateLineSubtotal(S, now, P)", () => {
    const bad: string[] = [];
    for (const s of [0, 0.01, 7, 10, 24, 43.75, 99.99]) {
      for (const p of [1, 2, 6, 20, 24, 40]) {
        for (let now = 0; now <= p; now++) {
          const got = prorateComponentCredit({
            storedSubtotal: s,
            linePieces: p,
            priorPieces: 0,
            parts: [now],
          }).total;
          if (got !== prorateLineSubtotal(s, now, p)) bad.push(`${s}/${now}/${p}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("prorateComponentCredit — refusals", () => {
  const base = { storedSubtotal: 10, linePieces: 6, priorPieces: 0, parts: [1] };

  it("prior + sum(parts) > linePieces throws", () => {
    expect(() => prorateComponentCredit({ ...base, priorPieces: 5, parts: [1, 1] })).toThrow(
      MoneyInvariantError,
    );
  });

  it.each([
    ["negative part", { parts: [2, -1] }],
    ["fractional part", { parts: [1.5] }],
    ["NaN part", { parts: [NaN] }],
    ["negative prior", { priorPieces: -1 }],
    ["zero linePieces", { linePieces: 0 }],
    ["negative linePieces", { linePieces: -6 }],
    ["negative subtotal", { storedSubtotal: -1 }],
    ["NaN subtotal", { storedSubtotal: NaN }],
    ["non-whole-cents subtotal (10.005)", { storedSubtotal: 10.005 }],
    ["sub-cent subtotal (0.004)", { storedSubtotal: 0.004 }],
  ])("%s throws", (_label, patch) => {
    expect(() => prorateComponentCredit({ ...base, ...patch })).toThrow(MoneyInvariantError);
  });
});

/** mulberry32 — a seeded PRNG, never Math.random (the #2733 seedCode flake). */
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

describe("prorateComponentCredit — seeded property sweep", () => {
  it("every event >= 0, parts whole cents summing to the event, prefix <= S, == S at P", () => {
    const rnd = mulberry32(2717);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const failures: string[] = [];
    for (let run = 0; run < 400; run++) {
      const S = int(0, 500000) / 100;
      const P = int(1, 60);
      const width = int(1, 4);
      let prior = 0;
      let credited = 0;
      while (prior < P) {
        const parts: number[] = [];
        let room = P - prior;
        for (let i = 0; i < width; i++) {
          const take = i === width - 1 || rnd() < 0.3 ? int(0, room) : int(0, Math.min(room, 5));
          parts.push(take);
          room -= take;
        }
        const now = parts.reduce((a, b) => a + b, 0);
        if (now === 0) {
          // force progress so the walk terminates
          parts[0] = 1;
        }
        const r = prorateComponentCredit({
          storedSubtotal: S,
          linePieces: P,
          priorPieces: prior,
          parts,
        });
        const tag = `run${run} S=${S} P=${P} prior=${prior} parts=${parts}`;
        if (!(r.total >= 0)) failures.push(`neg total ${tag}`);
        if (r.parts.some((x) => !(x >= 0) || !isWholeCents(x))) failures.push(`bad part ${tag}`);
        if (sumCents(r.parts) !== cents(r.total)) failures.push(`sum!=total ${tag}`);
        credited += cents(r.total);
        prior += parts.reduce((a, b) => a + b, 0);
        if (credited > cents(S)) failures.push(`prefix>S ${tag}`);
      }
      if (credited !== cents(S)) failures.push(`final!=S run${run} S=${S} P=${P}`);
    }
    expect(failures).toEqual([]);
  });
});
