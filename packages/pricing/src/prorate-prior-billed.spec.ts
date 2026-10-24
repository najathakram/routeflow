import { prorateLineSubtotal, roundMoney } from "./pricing";

/**
 * `prorateLineSubtotal(..., priorBilledQty)` is the web's preview of one partial invoice of an order
 * line. It must equal what the server bills: `buildInvoiceItemData` in
 * apps/api/src/invoices/invoices.service.ts (the telescoping cumulative rounding keyed on how much
 * the line already billed, on the PAID basis when the line has BUY_N_GET_M free units).
 *
 * `serverOracle` is a line-for-line transcription of that function's stored-subtotal branch.
 */
function serverOracle(p: {
  storedSubtotal: number;
  orderQty: number;
  billQty: number;
  prior: number;
  storedFreeUnits: number;
  freeUnitSize: number; // unitsPerBox on a box-split line, else 1
}): number {
  const { storedSubtotal, orderQty, billQty, prior, storedFreeUnits, freeUnitSize } = p;
  const hasFreeUnits = storedFreeUnits > 0 && orderQty > 0;
  const freeUnitsThrough = (cumQty: number) =>
    Math.min(storedFreeUnits, Math.floor((storedFreeUnits * Math.max(0, cumQty)) / orderQty));
  const paidQty = orderQty - storedFreeUnits * freeUnitSize;
  const onPaidBasis = hasFreeUnits && paidQty > 0;
  const basisQty = onPaidBasis ? paidQty : orderQty;
  const billedThrough = (cumQty: number) =>
    onPaidBasis ? cumQty - freeUnitsThrough(cumQty) * freeUnitSize : cumQty;
  return roundMoney(
    roundMoney((storedSubtotal * Math.min(billedThrough(prior + billQty), basisQty)) / basisQty) -
      roundMoney((storedSubtotal * Math.min(billedThrough(prior), basisQty)) / basisQty),
  );
}

describe("prorateLineSubtotal — priorBilledQty (partial N of an order line)", () => {
  it("12 pcs @ $35 with 2 free (stored $350), billing 5 bills $175.00 — not the raw-qty $145.83", () => {
    // paidQty = 12 - 2 = 10; freeUnitsThrough(5) = floor(2*5/12) = 0; 350 * 5 / 10 = 175.
    expect(prorateLineSubtotal(350, 5, 12, 2, 1, 0)).toBe(175);
    expect(roundMoney((350 * 5) / 12)).toBe(145.83); // what a raw-qty proration gave
  });

  it("the +-1 cent case: $10.00 over 3 pcs bills 3.33, then 3.34, then 3.33 (sums to the line)", () => {
    const first = prorateLineSubtotal(10, 1, 3, 0, 1, 0);
    const second = prorateLineSubtotal(10, 1, 3, 0, 1, 1);
    const third = prorateLineSubtotal(10, 1, 3, 0, 1, 2);
    expect([first, second, third]).toEqual([3.33, 3.34, 3.33]);
    expect(roundMoney(first + second + third)).toBe(10);
    // an independent per-bill proration (no prior) is a cent off on the middle bill
    expect(prorateLineSubtotal(10, 1, 3)).toBe(3.33);
  });

  it("billing the remainder after a prior partial telescopes to the rest of the line", () => {
    expect(prorateLineSubtotal(10, 2, 3, 0, 1, 1)).toBe(6.67);
  });

  it("prior 0 (the default) is exactly the old from-scratch result", () => {
    expect(prorateLineSubtotal(50, 3, 6, 1)).toBe(30);
    expect(prorateLineSubtotal(50, 3, 6, 1, 1, 0)).toBe(30);
  });

  it("a boxed BUY_N_GET_M line (free unit = a box of 4) matches the server across every bill/prior", () => {
    // 10 pcs, 4/box, 1 free box, stored $30: paidQty = 6.
    for (let prior = 0; prior <= 10; prior++) {
      for (let bill = 1; prior + bill <= 10; bill++) {
        expect(prorateLineSubtotal(30, bill, 10, 1, 4, prior)).toBe(
          serverOracle({
            storedSubtotal: 30,
            orderQty: 10,
            billQty: bill,
            prior,
            storedFreeUnits: 1,
            freeUnitSize: 4,
          }),
        );
      }
    }
  });

  it("matches the server oracle over a grid of stored money, qty, free units, pack size and splits", () => {
    let checked = 0;
    for (const stored of [10, 33.33, 350, 1234.56]) {
      for (const orderQty of [1, 3, 7, 12, 24]) {
        for (const [free, size] of [
          [0, 1],
          [1, 1],
          [2, 1],
          [1, 4],
          [2, 6],
        ] as const) {
          if (free * size >= orderQty && free > 0) continue; // a line cannot be all free units
          for (let prior = 0; prior < orderQty; prior += 1) {
            for (let bill = 1; prior + bill <= orderQty; bill += 1) {
              expect(prorateLineSubtotal(stored, bill, orderQty, free, size, prior)).toBe(
                serverOracle({
                  storedSubtotal: stored,
                  orderQty,
                  billQty: bill,
                  prior,
                  storedFreeUnits: free,
                  freeUnitSize: size,
                }),
              );
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("successive partials of a whole line sum to exactly the stored subtotal (no free units)", () => {
    for (const orderQty of [3, 7, 12]) {
      let prior = 0;
      let sum = 0;
      while (prior < orderQty) {
        sum += prorateLineSubtotal(10, 1, orderQty, 0, 1, prior);
        prior += 1;
      }
      expect(roundMoney(sum)).toBe(10);
    }
  });
});
