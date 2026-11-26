/**
 * SA-1540 P1 (Ops W-1483) - landed cost money helpers: spreading a purchase-order charge
 * (freight, duty, fees; before tax) over the received lines, and splitting a line's share three
 * ways (stock / goods out on open orders / cost of goods sold true-up).
 *
 * Expected values are hand-worked decimals from the SA-1540 spec (sections 3.1, 3.5, 5). Every
 * share is whole cents and the parts sum EXACTLY to the input.
 */
import { MoneyInvariantError, allocateCentsLargestRemainder } from "./index";
import { allocatePoCharge, splitLandedShare, type SplitLandedShareInput } from "./landed-cost";

const cents = (n: number) => Math.round(n * 100);
const sumCents = (xs: number[]) => xs.reduce((a, x) => a + cents(x), 0);
const line = (receivedPieces: number, receivedValue: number, manualAmount?: number) =>
  manualAmount === undefined
    ? { receivedPieces, receivedValue }
    : { receivedPieces, receivedValue, manualAmount };

describe("SA-1540 P1 allocatePoCharge", () => {
  describe("VALUE (the default basis)", () => {
    it("R1: $1,500 over received merchandise $7,000 / $3,000 -> 1050.00 / 450.00", () => {
      const lines = [line(70, 7000), line(30, 3000)];
      expect(allocatePoCharge({ amount: 1500, basis: "VALUE", lines })).toEqual([1050, 450]);
    });

    it("an omitted basis means VALUE", () => {
      const lines = [line(70, 7000), line(30, 3000)];
      expect(allocatePoCharge({ amount: 1500, lines })).toEqual([1050, 450]);
    });

    it("R2: $100 over three equal lines -> 33.34 / 33.33 / 33.33 (the odd cent goes first)", () => {
      const lines = [line(1, 10), line(1, 10), line(1, 10)];
      expect(allocatePoCharge({ amount: 100, basis: "VALUE", lines })).toEqual([
        33.34, 33.33, 33.33,
      ]);
    });

    it("a line with nothing received gets 0 and the others carry the whole charge", () => {
      const lines = [line(0, 0), line(5, 50), line(5, 50)];
      expect(allocatePoCharge({ amount: 10, basis: "VALUE", lines })).toEqual([0, 5, 5]);
    });

    it("amount 0 gives zeros, even with nothing received", () => {
      const lines = [line(0, 0), line(0, 0)];
      expect(allocatePoCharge({ amount: 0, basis: "VALUE", lines })).toEqual([0, 0]);
    });

    it("a positive amount with no received value at all is refused", () => {
      expect(() => allocatePoCharge({ amount: 10, basis: "VALUE", lines: [line(0, 0)] })).toThrow(
        MoneyInvariantError,
      );
      expect(() => allocatePoCharge({ amount: 10, basis: "VALUE", lines: [] })).toThrow(
        MoneyInvariantError,
      );
    });

    it("refuses a negative amount, a sub-cent amount and a sub-cent received value", () => {
      const lines = [line(1, 10)];
      expect(() => allocatePoCharge({ amount: -1, basis: "VALUE", lines })).toThrow(
        MoneyInvariantError,
      );
      expect(() => allocatePoCharge({ amount: 0.005, basis: "VALUE", lines })).toThrow(
        MoneyInvariantError,
      );
      expect(() =>
        allocatePoCharge({ amount: 1, basis: "VALUE", lines: [line(1, 10.005)] }),
      ).toThrow(MoneyInvariantError);
    });

    it("refuses non-integer or negative pieces, and a negative received value", () => {
      expect(() => allocatePoCharge({ amount: 1, basis: "VALUE", lines: [line(1.5, 10)] })).toThrow(
        MoneyInvariantError,
      );
      expect(() => allocatePoCharge({ amount: 1, basis: "VALUE", lines: [line(-1, 10)] })).toThrow(
        MoneyInvariantError,
      );
      expect(() => allocatePoCharge({ amount: 1, basis: "VALUE", lines: [line(1, -10)] })).toThrow(
        MoneyInvariantError,
      );
    });
  });

  describe("QUANTITY (by pieces)", () => {
    it("1 case of 12 pieces vs 200 pieces, $120 -> 6.79 / 113.21", () => {
      const lines = [line(12, 600), line(200, 40)];
      expect(allocatePoCharge({ amount: 120, basis: "QUANTITY", lines })).toEqual([6.79, 113.21]);
    });

    it("ignores value: equal pieces split evenly whatever the line value", () => {
      const lines = [line(10, 1), line(10, 9999)];
      expect(allocatePoCharge({ amount: 50, basis: "QUANTITY", lines })).toEqual([25, 25]);
    });

    it("a line with 0 pieces gets 0; no pieces anywhere is refused for a positive amount", () => {
      expect(
        allocatePoCharge({ amount: 9, basis: "QUANTITY", lines: [line(0, 0), line(3, 5)] }),
      ).toEqual([0, 9]);
      expect(() =>
        allocatePoCharge({ amount: 9, basis: "QUANTITY", lines: [line(0, 0), line(0, 0)] }),
      ).toThrow(MoneyInvariantError);
    });
  });

  describe("inconsistent lines (value with nothing received)", () => {
    it("VALUE: a line with 0 pieces but a received value is refused", () => {
      expect(() =>
        allocatePoCharge({ amount: 10, basis: "VALUE", lines: [line(0, 25), line(5, 50)] }),
      ).toThrow(MoneyInvariantError);
    });

    it("QUANTITY: a line with 0 pieces but a received value is refused", () => {
      expect(() =>
        allocatePoCharge({ amount: 10, basis: "QUANTITY", lines: [line(0, 25), line(5, 50)] }),
      ).toThrow(MoneyInvariantError);
    });

    it("a 0 pieces / 0 value line still just gets 0", () => {
      const lines = [line(0, 0), line(5, 50)];
      expect(allocatePoCharge({ amount: 10, basis: "VALUE", lines })).toEqual([0, 10]);
      expect(allocatePoCharge({ amount: 10, basis: "QUANTITY", lines })).toEqual([0, 10]);
    });
  });

  describe("overflow guard (R19, F16): cents x sum(weights) above 2^53 is refused", () => {
    it("VALUE: a $90,000 charge over two lines of $50,000,000 (weights sum 1e10, product 9e16)", () => {
      const lines = [line(1, 50_000_000), line(1, 50_000_000)];
      expect(() => allocatePoCharge({ amount: 90000, basis: "VALUE", lines })).toThrow(
        MoneyInvariantError,
      );
    });

    it("QUANTITY: the same charge over 5,000,000 pieces on each of two lines", () => {
      const lines = [line(5_000_000, 1), line(5_000_000, 1)];
      expect(() => allocatePoCharge({ amount: 90000, basis: "QUANTITY", lines })).toThrow(
        MoneyInvariantError,
      );
    });

    it("the spec's real scale is accepted: $90,000 over $1,000,000 of merchandise (9e14)", () => {
      const lines = [line(60, 600_000), line(40, 400_000)];
      expect(allocatePoCharge({ amount: 90000, basis: "VALUE", lines })).toEqual([54000, 36000]);
    });

    it("a zero charge never trips the guard", () => {
      const lines = [line(1, 50_000_000), line(1, 50_000_000)];
      expect(allocatePoCharge({ amount: 0, basis: "VALUE", lines })).toEqual([0, 0]);
    });
  });

  describe("MANUAL", () => {
    it("returns the typed amounts when they sum to the charge exactly", () => {
      const lines = [line(4, 40, 70.01), line(6, 60, 49.99)];
      expect(allocatePoCharge({ amount: 120, basis: "MANUAL", lines })).toEqual([70.01, 49.99]);
    });

    it("R20: amounts summing to 119.99 for a 120.00 charge are refused", () => {
      const lines = [line(4, 40, 70), line(6, 60, 49.99)];
      expect(() => allocatePoCharge({ amount: 120, basis: "MANUAL", lines })).toThrow(
        MoneyInvariantError,
      );
    });

    it("amounts summing to more than the charge are refused too", () => {
      const lines = [line(4, 40, 70), line(6, 60, 50.01)];
      expect(() => allocatePoCharge({ amount: 120, basis: "MANUAL", lines })).toThrow(
        MoneyInvariantError,
      );
    });

    it("a manual amount above 0 on a line with nothing received is refused", () => {
      const lines = [line(0, 0, 20), line(6, 60, 100)];
      expect(() => allocatePoCharge({ amount: 120, basis: "MANUAL", lines })).toThrow(
        MoneyInvariantError,
      );
    });

    it("a zero manual amount on an unreceived line is fine", () => {
      const lines = [line(0, 0, 0), line(6, 60, 120)];
      expect(allocatePoCharge({ amount: 120, basis: "MANUAL", lines })).toEqual([0, 120]);
    });

    it("refuses a negative or sub-cent manual amount", () => {
      expect(() =>
        allocatePoCharge({
          amount: 10,
          basis: "MANUAL",
          lines: [line(1, 1, -5), line(1, 1, 15)],
        }),
      ).toThrow(MoneyInvariantError);
      expect(() =>
        allocatePoCharge({ amount: 10, basis: "MANUAL", lines: [line(1, 1, 10.001)] }),
      ).toThrow(MoneyInvariantError);
    });

    it("a typed -0 comes back as +0 (never negative zero)", () => {
      const out = allocatePoCharge({
        amount: 10,
        basis: "MANUAL",
        lines: [line(1, 1, -0), line(1, 1, 10)],
      });
      expect(out).toEqual([0, 10]);
      expect(Object.is(out[0], 0)).toBe(true);
    });

    it("amount 0 with all-zero manual amounts gives zeros", () => {
      expect(
        allocatePoCharge({ amount: 0, basis: "MANUAL", lines: [line(1, 1, 0), line(1, 1, 0)] }),
      ).toEqual([0, 0]);
    });
  });

  it("an unknown basis (WEIGHT is LATER) is refused", () => {
    expect(() =>
      allocatePoCharge({ amount: 1, basis: "WEIGHT" as never, lines: [line(1, 1)] }),
    ).toThrow(MoneyInvariantError);
  });
});

const split = (over: Partial<SplitLandedShareInput> = {}) =>
  splitLandedShare({
    allocated: 120,
    notYetCostedPieces: 4,
    alreadyCostedPieces: 6,
    productInStock: 4,
    productOpenOrderPieces: 0,
    ...over,
  });
const parts = (r: { toStock: number; toOpenOrders: number; toCogs: number }) => [
  r.toStock,
  r.toOpenOrders,
  r.toCogs,
];

describe("SA-1540 P1 splitLandedShare", () => {
  it("R3: 10 received, 6 already invoiced, 4 in stock, $120 -> toStock 48.00, toCogs 72.00", () => {
    const r = split();
    expect(r).toEqual({ toStock: 48, toOpenOrders: 0, toCogs: 72, mode: "CAPITALISED" });
    // the naive builds: all $120 to stock, or nothing to cost of goods sold
    expect(r.toStock).not.toBe(120);
    expect(r.toCogs).not.toBe(0);
  });

  it("goods out on open orders: 6 not yet costed (4 in stock + 2 open) of 10 -> 48 / 24 / 48", () => {
    const r = split({
      notYetCostedPieces: 6,
      alreadyCostedPieces: 4,
      productInStock: 4,
      productOpenOrderPieces: 2,
    });
    expect(r).toEqual({ toStock: 48, toOpenOrders: 24, toCogs: 48, mode: "CAPITALISED" });
  });

  it("nothing sold yet: the whole share capitalises to stock", () => {
    const r = split({ notYetCostedPieces: 10, alreadyCostedPieces: 0, productInStock: 10 });
    expect(r).toEqual({ toStock: 120, toOpenOrders: 0, toCogs: 0, mode: "CAPITALISED" });
  });

  it("the odd cent is placed by largest remainder and the parts still sum exactly", () => {
    const r = split({
      allocated: 100,
      notYetCostedPieces: 3,
      alreadyCostedPieces: 0,
      productInStock: 1,
      productOpenOrderPieces: 2,
    });
    expect(r).toEqual({ toStock: 33.33, toOpenOrders: 66.67, toCogs: 0, mode: "CAPITALISED" });
    expect(sumCents(parts(r))).toBe(10000);
  });

  describe("product-level stock, line-level pieces (section 3.5)", () => {
    it("R5: this PO 10, a later PO 20, product stock 22: this line's 2 pieces -> 24.00 / 96.00, toStock 24.00", () => {
      // The later PO's 20 pieces are the newest, so this line keeps 2 not-yet-costed pieces.
      const r = split({
        allocated: 120,
        notYetCostedPieces: 2,
        alreadyCostedPieces: 8,
        productInStock: 22,
        productOpenOrderPieces: 0,
      });
      // 120 over [2, 8] -> 24.00 not yet costed / 96.00 toCogs; the 24.00 rides the product's
      // 22 pieces in stock (the naive reading, line stock = 2, gives the same here).
      expect(r).toEqual({ toStock: 24, toOpenOrders: 0, toCogs: 96, mode: "CAPITALISED" });
    });

    it("a line with nothing not-yet-costed while the product has stock: CAPITALISED, all its cents to toCogs", () => {
      const r = split({
        notYetCostedPieces: 0,
        alreadyCostedPieces: 10,
        productInStock: 22,
        productOpenOrderPieces: 3,
      });
      expect(r).toEqual({ toStock: 0, toOpenOrders: 0, toCogs: 120, mode: "CAPITALISED" });
    });

    it("two lines of one product share the product's stock and open orders; each line conserves", () => {
      // product: 10 in stock, 5 out on open orders (15 not yet costed); line A newest-first keeps
      // 9, line B keeps 6; each line received 12 (A allocated 100.00, B allocated 50.00).
      const a = split({
        allocated: 100,
        notYetCostedPieces: 9,
        alreadyCostedPieces: 3,
        productInStock: 10,
        productOpenOrderPieces: 5,
      });
      const b = split({
        allocated: 50,
        notYetCostedPieces: 6,
        alreadyCostedPieces: 6,
        productInStock: 10,
        productOpenOrderPieces: 5,
      });
      // A: 100 over [9, 3] -> 75.00 / 25.00; 75.00 over [10, 5] -> 50.00 / 25.00
      expect(a).toEqual({ toStock: 50, toOpenOrders: 25, toCogs: 25, mode: "CAPITALISED" });
      // B: 50 over [6, 6] -> 25.00 / 25.00; 25.00 over [10, 5] -> 16.67 / 8.33
      expect(b).toEqual({ toStock: 16.67, toOpenOrders: 8.33, toCogs: 25, mode: "CAPITALISED" });
      expect(sumCents(parts(a))).toBe(10000);
      expect(sumCents(parts(b))).toBe(5000);
    });

    it("the line's not-yet-costed pieces cannot exceed the product's stock plus open orders", () => {
      expect(() =>
        split({ notYetCostedPieces: 7, productInStock: 4, productOpenOrderPieces: 2 }),
      ).toThrow(MoneyInvariantError);
    });
  });

  it("STANDARD: everything to cost of goods sold, whatever the stock", () => {
    const r = split({ standard: true });
    expect(r).toEqual({ toStock: 0, toOpenOrders: 0, toCogs: 120, mode: "EXPENSED_STANDARD" });
  });

  it("a ledger gap: everything to cost of goods sold, never a block", () => {
    const r = split({ ledgerGap: true });
    expect(r).toEqual({ toStock: 0, toOpenOrders: 0, toCogs: 120, mode: "EXPENSED_LEDGER_GAP" });
  });

  it("STANDARD and a ledger gap never validate the piece counts (a gap never blocks)", () => {
    const junk = {
      notYetCostedPieces: -3,
      alreadyCostedPieces: 1.5,
      productInStock: Number.NaN,
      productOpenOrderPieces: -1,
    };
    expect(split({ ...junk, standard: true }).mode).toBe("EXPENSED_STANDARD");
    expect(split({ ...junk, ledgerGap: true }).mode).toBe("EXPENSED_LEDGER_GAP");
  });

  it("R8: the product has nothing not yet costed: EXPENSED_NO_STOCK, all to cost of goods sold", () => {
    const r = split({ notYetCostedPieces: 0, alreadyCostedPieces: 10, productInStock: 0 });
    expect(r).toEqual({ toStock: 0, toOpenOrders: 0, toCogs: 120, mode: "EXPENSED_NO_STOCK" });
  });

  it("an oversold product (negative stock) is EXPENSED_NO_STOCK when stock + open orders <= 0", () => {
    const r = split({
      notYetCostedPieces: 0,
      alreadyCostedPieces: 10,
      productInStock: -3,
      productOpenOrderPieces: 3,
    });
    expect(r).toEqual({ toStock: 0, toOpenOrders: 0, toCogs: 120, mode: "EXPENSED_NO_STOCK" });
    expect(split({ notYetCostedPieces: 0, alreadyCostedPieces: 10, productInStock: -5 }).mode).toBe(
      "EXPENSED_NO_STOCK",
    );
  });

  // R8 (spec §3.3/§5): a LANDED_COST row is written only when locked stock > 0, so with no stock at B the average
  // cannot rise; open orders would then be invoiced at the OLD average and an open-orders share would reach neither
  // stock value nor COGS (the "value vanishes" wrong answer). Stock <= 0 is therefore EXPENSED_NO_STOCK, open orders
  // or not: everything to toCogs, no ledger row.
  it("R8: stock 0 at B with open orders is EXPENSED_NO_STOCK, every cent to toCogs", () => {
    const r = split({
      notYetCostedPieces: 3,
      alreadyCostedPieces: 7,
      productInStock: 0,
      productOpenOrderPieces: 3,
    });
    expect(r).toEqual({ toStock: 0, toOpenOrders: 0, toCogs: 120, mode: "EXPENSED_NO_STOCK" });
  });

  it("R8: an oversold product with open orders above 0 is EXPENSED_NO_STOCK too", () => {
    const r = split({
      notYetCostedPieces: 4,
      alreadyCostedPieces: 6,
      productInStock: -2,
      productOpenOrderPieces: 6,
    });
    expect(r).toEqual({ toStock: 0, toOpenOrders: 0, toCogs: 120, mode: "EXPENSED_NO_STOCK" });
  });

  it("precedence: standard, then ledger gap, then no stock", () => {
    const empty = { notYetCostedPieces: 0, alreadyCostedPieces: 10, productInStock: 0 };
    expect(split({ ...empty, standard: true, ledgerGap: true }).mode).toBe("EXPENSED_STANDARD");
    expect(split({ ...empty, ledgerGap: true }).mode).toBe("EXPENSED_LEDGER_GAP");
    expect(split({ ...empty }).mode).toBe("EXPENSED_NO_STOCK");
    expect(split({ standard: true, ledgerGap: true }).mode).toBe("EXPENSED_STANDARD");
  });

  it("amount 0 gives zeros in every mode", () => {
    const variants: Partial<SplitLandedShareInput>[] = [
      {},
      { standard: true },
      { ledgerGap: true },
      { notYetCostedPieces: 0, productInStock: 0 },
    ];
    for (const over of variants) {
      const r = split({ allocated: 0, ...over });
      expect(parts(r)).toEqual([0, 0, 0]);
      expect(parts(r).every((x) => Object.is(x, 0))).toBe(true);
    }
  });

  it("splitLandedShare: refuses a huge piece count against a large share (R19 on the split)", () => {
    expect(() =>
      split({
        allocated: 90000,
        notYetCostedPieces: 5_000_000_000,
        alreadyCostedPieces: 5_000_000_000,
        productInStock: 5_000_000_000,
      }),
    ).toThrow(MoneyInvariantError);
  });

  describe("a reversal posting (negative allocated, section 3.6)", () => {
    const open = {
      notYetCostedPieces: 6,
      alreadyCostedPieces: 4,
      productInStock: 4,
      productOpenOrderPieces: 2,
    };

    it("splits the size the same way and negates every share", () => {
      const fwd = split(open);
      const rev = split({ ...open, allocated: -120 });
      expect(rev).toEqual({ toStock: -48, toOpenOrders: -24, toCogs: -48, mode: "CAPITALISED" });
      expect(rev.toStock).toBe(-fwd.toStock);
      expect(sumCents(parts(rev))).toBe(-12000);
    });

    it("an expensed reversal puts the whole negative amount in cost of goods sold", () => {
      expect(split({ allocated: -120, standard: true })).toEqual({
        toStock: 0,
        toOpenOrders: 0,
        toCogs: -120,
        mode: "EXPENSED_STANDARD",
      });
    });

    it("never returns negative zero", () => {
      const r = split({
        allocated: -120,
        notYetCostedPieces: 10,
        alreadyCostedPieces: 0,
        productInStock: 10,
      });
      expect(Object.is(r.toCogs, 0)).toBe(true);
      expect(Object.is(r.toOpenOrders, 0)).toBe(true);
      expect(r.toStock).toBe(-120);
    });
  });

  describe("refusals (only on the paths that use the pieces)", () => {
    it("the line's pieces must be integers >= 0", () => {
      expect(() => split({ alreadyCostedPieces: -1 })).toThrow(MoneyInvariantError);
      expect(() => split({ notYetCostedPieces: 1.5 })).toThrow(MoneyInvariantError);
      expect(() => split({ notYetCostedPieces: -1 })).toThrow(MoneyInvariantError);
    });

    it("the product's open-order pieces are >= 0 integers and its stock an integer", () => {
      expect(() => split({ productOpenOrderPieces: -1 })).toThrow(MoneyInvariantError);
      expect(() => split({ productOpenOrderPieces: 0.5 })).toThrow(MoneyInvariantError);
      expect(() => split({ productInStock: 1.5 })).toThrow(MoneyInvariantError);
      expect(() => split({ productInStock: Number.NaN })).toThrow(MoneyInvariantError);
    });

    it("allocated must be finite whole cents (checked in every mode)", () => {
      expect(() => split({ allocated: 0.005 })).toThrow(MoneyInvariantError);
      expect(() => split({ allocated: Number.NaN })).toThrow(MoneyInvariantError);
      expect(() => split({ allocated: Number.POSITIVE_INFINITY, standard: true })).toThrow(
        MoneyInvariantError,
      );
    });
  });
});

/** mulberry32 - a seeded PRNG, never Math.random (the loops must be reproducible). */
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

describe("SA-1540 P1 conservation (seeded property loops)", () => {
  it("allocatePoCharge: every basis sums exactly to the amount, shares whole cents and >= 0", () => {
    const rnd = mulberry32(1540);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const failures: string[] = [];
    for (let run = 0; run < 400; run++) {
      const n = int(1, 7);
      const lines = Array.from({ length: n }, () => {
        const pieces = rnd() < 0.2 ? 0 : int(1, 500);
        return line(pieces, pieces === 0 ? 0 : int(1, 2_000_000) / 100);
      });
      const amount = int(0, 5_000_000) / 100;
      const received = lines.some((l) => l.receivedPieces > 0);
      for (const basis of ["VALUE", "QUANTITY"] as const) {
        const tag = `run${run} ${basis} amount=${amount} lines=${JSON.stringify(lines)}`;
        if (!received && amount > 0) {
          try {
            allocatePoCharge({ amount, basis, lines });
            failures.push(`no throw ${tag}`);
          } catch (e) {
            if (!(e instanceof MoneyInvariantError)) failures.push(`wrong error ${tag}`);
          }
          continue;
        }
        const out = allocatePoCharge({ amount, basis, lines });
        if (out.length !== n) failures.push(`length ${tag}`);
        if (sumCents(out) !== cents(amount)) failures.push(`sum ${tag}`);
        out.forEach((x, i) => {
          if (!(x >= 0) || Object.is(x, -0) || Math.abs(x * 100 - Math.round(x * 100)) > 1e-6) {
            failures.push(`part ${tag}`);
          }
          if (lines[i].receivedPieces === 0 && x !== 0) failures.push(`unreceived ${tag}`);
        });
      }
      // MANUAL: split the amount into random cent parts across the received lines
      if (received) {
        const idx = lines.map((l, i) => (l.receivedPieces > 0 ? i : -1)).filter((i) => i >= 0);
        let left = cents(amount);
        const manual = lines.map(() => 0);
        idx.forEach((i, k) => {
          const take = k === idx.length - 1 ? left : int(0, left);
          manual[i] = take;
          left -= take;
        });
        const ml = lines.map((l, i) => ({ ...l, manualAmount: manual[i] / 100 }));
        const out = allocatePoCharge({ amount, basis: "MANUAL", lines: ml });
        if (sumCents(out) !== cents(amount)) failures.push(`manual sum run${run}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("splitLandedShare: shares sum exactly to allocated (both signs, every mode, independent product stock)", () => {
    const rnd = mulberry32(20261126);
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
    const failures: string[] = [];
    for (let run = 0; run < 800; run++) {
      // product level: stock may be negative (oversold), open orders >= 0, drawn independently
      const productInStock = rnd() < 0.15 ? -int(1, 50) : rnd() < 0.2 ? 0 : int(0, 300);
      const productOpenOrderPieces = rnd() < 0.4 ? 0 : int(0, 300);
      const ceiling = Math.max(0, productInStock) + productOpenOrderPieces;
      // line level: not-yet-costed never above the product's positive sum
      const notYetCostedPieces = ceiling === 0 || rnd() < 0.15 ? 0 : int(0, ceiling);
      const alreadyCostedPieces = rnd() < 0.2 ? 0 : int(0, 600);
      const magnitude = int(0, 9_000_000) / 100;
      const allocated = rnd() < 0.3 ? -magnitude : magnitude;
      const standard = rnd() < 0.1;
      const ledgerGap = rnd() < 0.1;
      const input: SplitLandedShareInput = {
        allocated,
        notYetCostedPieces,
        alreadyCostedPieces,
        productInStock,
        productOpenOrderPieces,
        standard,
        ledgerGap,
      };
      const tag = JSON.stringify({ run, ...input });
      const productNotYetCosted = productInStock + productOpenOrderPieces;
      // allocated > 0 with both line weights 0 is refused by the allocator (nothing to weigh)
      const unweighable = notYetCostedPieces + alreadyCostedPieces === 0 && magnitude > 0;
      let r;
      try {
        r = splitLandedShare(input);
      } catch (e) {
        const expected = unweighable && !standard && !ledgerGap && productNotYetCosted > 0;
        if (!(e instanceof MoneyInvariantError) || !expected) failures.push(`threw ${tag}`);
        continue;
      }
      if (sumCents(parts(r)) !== cents(allocated)) failures.push(`sum ${tag}`);
      for (const x of parts(r)) {
        const ok = allocated >= 0 ? x >= 0 : x <= 0;
        if (!ok || Object.is(x, -0)) failures.push(`sign ${tag}`);
      }
      if (r.mode !== "CAPITALISED" && (r.toStock !== 0 || r.toOpenOrders !== 0)) {
        failures.push(`expensed leak ${tag}`);
      }
      if (!standard && !ledgerGap) {
        // R8: with no stock at B no ledger row can raise the average, so open orders would be invoiced at the old
        // one and their share would reach neither stock value nor COGS: stock <= 0 is EXPENSED_NO_STOCK.
        const expectedMode =
          productInStock <= 0 || productNotYetCosted <= 0 ? "EXPENSED_NO_STOCK" : "CAPITALISED";
        if (r.mode !== expectedMode) failures.push(`mode ${tag}`);
      }
      if (r.mode === "CAPITALISED") {
        // toStock + toOpenOrders is exactly the first split's not-yet-costed dollars
        const first = allocateCentsLargestRemainder(Math.abs(allocated), [
          notYetCostedPieces,
          alreadyCostedPieces,
        ]);
        if (cents(r.toStock) + cents(r.toOpenOrders) !== Math.sign(allocated) * cents(first[0])) {
          failures.push(`first split ${tag}`);
        }
        if (cents(r.toCogs) !== Math.sign(allocated) * cents(first[1])) {
          failures.push(`toCogs ${tag}`);
        }
        if (productInStock <= 0 && r.toStock !== 0) failures.push(`stock leak ${tag}`);
      }
      if (allocated > 0) {
        const mirror = splitLandedShare({ ...input, allocated: -allocated });
        if (
          mirror.toStock !== 0 - r.toStock ||
          mirror.toOpenOrders !== 0 - r.toOpenOrders ||
          mirror.toCogs !== 0 - r.toCogs ||
          mirror.mode !== r.mode
        ) {
          failures.push(`mirror ${tag}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
