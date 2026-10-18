import { ConflictException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { effectiveTaxRateFromTotals } from "../common/tax-rate";
import { allocateOrderRegularTax } from "./manual-invoice-context";
import {
  assertTaxStateRecomputable,
  guardItemsEditTaxState,
  ORDER_ALLOCATION_TOLERANCE_CENTS,
  orderSiblingCountOf,
} from "./stored-tax-state";

/**
 * SA-814e — an ORDER-LINKED invoice's tax is the order's tax allocated across the invoices cut from it, so a
 * correct one can sit a cent per sibling away from the sum of its lines at their stored rate. The guard
 * tolerates exactly that (ORDER_ALLOCATION_TOLERANCE_CENTS x the siblings sharing the order, plus half a cent)
 * and still refuses a stored state that is really wrong (the B294 all-zero rows, B296's 4-place rate).
 */
const base = { canRestamp: false, path: "DRAFT_EDIT" as const };

/** mulberry32: a tiny deterministic PRNG so the property cases are the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The rate an order-derived line stores: order.tax / order.subtotal, kept to the column's 4 places. */
const storedRate = (orderTax: number, orderSubtotal: number): number =>
  Math.round(effectiveTaxRateFromTotals(orderTax, orderSubtotal, false) * 10_000) / 10_000;

describe("the order-allocation tolerance", () => {
  it("is one named constant: 1 cent per invoice sharing the order", () => {
    expect(ORDER_ALLOCATION_TOLERANCE_CENTS).toBe(1);
  });

  it("orderSiblingCountOf: null without an order, at least 1 with one", () => {
    expect(orderSiblingCountOf({ orderId: null })).toBeNull();
    expect(orderSiblingCountOf({ orderId: "o" })).toBe(1);
    expect(orderSiblingCountOf({ orderId: "o", orderInvoiceCount: 0 })).toBe(1);
    expect(orderSiblingCountOf({ orderId: "o", orderInvoiceCount: 3 })).toBe(3);
  });

  describe("(a) property: every correct order-derived split passes the guard", () => {
    const RATES = [0.0625, 0.07, 0.0825];
    const CASES_PER_SHAPE = 40;

    it.each(RATES.flatMap((rate) => [2, 3, 4].map((n) => [rate, n] as const)))(
      "%s tax, %s-way split (deterministic cases)",
      (rate, n) => {
        const rand = prng(Math.round(rate * 100_000) * 10 + n);
        for (let c = 0; c < CASES_PER_SHAPE; c++) {
          const groups = Array.from(
            { length: n },
            () => (100 + Math.floor(rand() * 149_900)) / 100,
          );
          const orderSubtotal = roundMoney(groups.reduce((s, g) => s + g, 0));
          const orderTax = roundMoney(orderSubtotal * rate);
          // the REAL allocator createInvoiceFromOrder / the draft-sibling rebuild call
          const shares = allocateOrderRegularTax(
            { tax: orderTax, subtotal: orderSubtotal },
            groups,
            false,
          );
          expect(roundMoney(shares.reduce((s, x) => s + x, 0))).toBe(orderTax);
          const lineRate = storedRate(orderTax, orderSubtotal);
          groups.forEach((g, i) => {
            const verdict = () =>
              assertTaxStateRecomputable({
                ...base,
                invoice: { subtotal: g, taxAmount: shares[i] },
                storedLines: [{ subtotal: g, taxRate: lineRate, categoryTaxAmount: 0 }],
                orderSiblingCount: n,
              });
            expect(verdict).not.toThrow();
          });
        }
      },
    );
  });

  describe("(b) the guard still refuses what is really wrong", () => {
    const eightEightSeventyFive = {
      invoice: { subtotal: 1234.56, taxAmount: 109.57 }, // 1234.56 x 0.08875 created unrounded
      storedLines: [{ subtotal: 1234.56, taxRate: 0.0888 }], // the column kept 4 places: 109.63, a 6 cent drift
    };
    const allZero = {
      invoice: { subtotal: 10000, taxAmount: 887.5 }, // legacy rows at rate 0; 0.0888 does not verify
      storedLines: [{ subtotal: 10000, taxRate: 0 }],
    };

    it.each([
      ["a manual invoice", undefined],
      ["an order-linked invoice, n = 1", 1],
    ])("B296: 8.875%% stored as 0.0888 x $1,234.56 (6 cents) on %s", (_name, count) => {
      expect(() =>
        assertTaxStateRecomputable({ ...base, ...eightEightSeventyFive, orderSiblingCount: count }),
      ).toThrow(ConflictException);
    });

    it.each([
      ["a manual invoice", undefined],
      ["an order-linked invoice, n = 1", 1],
    ])("B294: the all-zero rows whose rate does not verify on %s", (_name, count) => {
      expect(() =>
        assertTaxStateRecomputable({
          ...base,
          canRestamp: true,
          ...allZero,
          orderSiblingCount: count,
        }),
      ).toThrow(ConflictException);
    });

    it("a drift of n+1 cents on an n-way order is refused; n cents is allowed", () => {
      const at = (taxAmount: number, n: number) => () =>
        assertTaxStateRecomputable({
          ...base,
          invoice: { subtotal: 100, taxAmount },
          storedLines: [{ subtotal: 100, taxRate: 0.07 }], // lines say 7.00
          orderSiblingCount: n,
        });
      expect(at(7.02, 2)).not.toThrow();
      expect(at(7.03, 2)).toThrow(ConflictException);
      expect(at(7.01, 1)).not.toThrow();
      expect(at(7.02, 1)).toThrow(ConflictException);
    });
  });

  describe("(c) $384.20 + $29.97 at 6.25%, order tax $25.89", () => {
    const shares = allocateOrderRegularTax({ tax: 25.89, subtotal: 414.17 }, [384.2, 29.97], false);
    const lineRate = storedRate(25.89, 414.17);

    it("allocates 24.02 + 1.87 and stores the rate at 4 places", () => {
      expect(shares).toEqual([24.02, 1.87]);
      expect(lineRate).toBe(0.0625);
    });

    it("both invoices pass on the order (master refused the larger by 1 cent: 384.20 x 0.0625 = 24.01)", () => {
      [384.2, 29.97].forEach((g, i) => {
        const run = (orderSiblingCount: number | null) => () =>
          assertTaxStateRecomputable({
            ...base,
            invoice: { subtotal: g, taxAmount: shares[i] },
            storedLines: [{ subtotal: g, taxRate: lineRate }],
            orderSiblingCount,
          });
        expect(run(2)).not.toThrow();
        expect(run(1)).not.toThrow();
      });
      // the same figures on a manual invoice (half a cent) are the false refusal the tolerance removes
      expect(() =>
        assertTaxStateRecomputable({
          ...base,
          invoice: { subtotal: 384.2, taxAmount: 24.02 },
          storedLines: [{ subtotal: 384.2, taxRate: 0.0625 }],
        }),
      ).toThrow(ConflictException);
    });

    it("a DRAFT re-save (the items edit) of the larger invoice is not refused", () => {
      const row = { id: "a", subtotal: 384.2, taxRate: 0.0625, categoryTaxAmount: 0 };
      expect(() =>
        guardItemsEditTaxState({
          locked: {
            invoice: { subtotal: 384.2, taxAmount: 24.02, orderId: "ord-1" },
            storedRows: [row],
            isTaxExempt: false,
            orderInvoiceCount: 2,
          },
          items: [{ taxRate: 0.0625 }],
          matches: [{ row }],
          editLines: [{ rowId: "a", data: { taxRate: 0.0625 } }],
        }),
      ).not.toThrow();
    });
  });
});
