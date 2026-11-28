import { NSF_FEE_SYSTEM_KIND } from "@routeflow/pricing";
import {
  issuedRecomputeOf,
  issuedRecomputeState,
  restampEditLines,
  type StoredTaxLine,
} from "./stored-tax-state";

/**
 * SA-1508 commit 6 (consent), the stored-figures half. Red on master: `issuedRecomputeState`, `issuedRecomputeOf` and
 * `restampEditLines` do not exist (master has the DRAFT guard only: it refuses a stale tax or proceeds silently).
 * Fixtures are `acme` dummy data. Money arithmetic: three lines at 100.00 rate 0 with a stored tax of 24.75 is the
 * legacy shape whose verified flat rate is 0.0825.
 */
const line = (over: Record<string, unknown> = {}): StoredTaxLine & Record<string, unknown> => ({
  id: "r1",
  subtotal: 100,
  taxRate: 0,
  categoryTaxAmount: 0,
  ...over,
});
const STALE_LINES = [line({ id: "a" }), line({ id: "b" }), line({ id: "c" })];
const STALE_INV = { subtotal: 300, taxAmount: 24.75, discount: 0, shippingFee: 0, total: 324.75 };
const REPRODUCING_LINES = [0, 1, 2].map((i) => line({ id: `p${i}`, taxRate: 0.0825 }));

describe("issuedRecomputeState: the three states", () => {
  it("lines that reproduce the stored tax and total: REPRODUCES, nothing to stamp", () => {
    expect(
      issuedRecomputeState({
        invoice: STALE_INV,
        storedLines: REPRODUCING_LINES,
        isTaxExempt: false,
      }),
    ).toEqual({ state: "REPRODUCES", restampRate: null });
  });

  it("a stored tax the rate-0 lines cannot reproduce is TAX_STALE with the VERIFIED rate", () => {
    expect(
      issuedRecomputeState({ invoice: STALE_INV, storedLines: STALE_LINES, isTaxExempt: false }),
    ).toEqual({ state: "TAX_STALE", restampRate: 0.0825 });
  });

  it("an imported invoice (file total 108.25, tax 0, lines 100.00) is TOTAL_NOT_FROM_LINES, no rate", () => {
    const imported = { subtotal: 100, taxAmount: 0, discount: 0, shippingFee: 0, total: 108.25 };
    expect(
      issuedRecomputeState({ invoice: imported, storedLines: [line()], isTaxExempt: false }),
    ).toEqual({ state: "TOTAL_NOT_FROM_LINES", restampRate: null });
  });

  it("one cent of gap is still REPRODUCES; two cents is not (the judge counts cents)", () => {
    const inv = (total: number) => ({
      subtotal: 100,
      taxAmount: 0,
      discount: 0,
      shippingFee: 0,
      total,
    });
    expect(
      issuedRecomputeState({ invoice: inv(100.01), storedLines: [line()], isTaxExempt: false })
        .state,
    ).toBe("REPRODUCES");
    expect(
      issuedRecomputeState({ invoice: inv(100.02), storedLines: [line()], isTaxExempt: false })
        .state,
    ).toBe("TOTAL_NOT_FROM_LINES");
  });

  it("the stored discount and shipping are part of the total the lines must reproduce", () => {
    const inv = { subtotal: 100, taxAmount: 0, discount: 10, shippingFee: 5, total: 95 };
    expect(
      issuedRecomputeState({ invoice: inv, storedLines: [line()], isTaxExempt: false }).state,
    ).toBe("REPRODUCES");
  });

  it("an exempt customer never has a rate to stamp", () => {
    expect(
      issuedRecomputeState({ invoice: STALE_INV, storedLines: STALE_LINES, isTaxExempt: true })
        .restampRate,
    ).toBeNull();
  });
});

describe("issuedRecomputeOf: who is judged", () => {
  const db = { systemConfig: undefined };
  it("a DRAFT is null (master's rule), and so is an order-linked invoice", async () => {
    expect(
      await issuedRecomputeOf(db, { ...STALE_INV, status: "DRAFT" }, STALE_LINES, false),
    ).toBeNull();
    expect(
      await issuedRecomputeOf(
        db,
        { ...STALE_INV, status: "SENT", orderId: "o1" },
        STALE_LINES,
        false,
      ),
    ).toBeNull();
  });
  it("a standalone SENT invoice gets the verdict", async () => {
    expect(
      await issuedRecomputeOf(db, { ...STALE_INV, status: "SENT" }, STALE_LINES, false),
    ).toEqual({ state: "TAX_STALE", restampRate: 0.0825 });
  });
});

describe("restampEditLines (A4-STAMP): the stamp wins only over rate 0", () => {
  const stored = [
    line({ id: "a" }),
    line({ id: "b", taxRate: 0.05 }),
    line({ id: "n", systemKind: NSF_FEE_SYSTEM_KIND }),
  ];
  const edit = (rowId: string | null, taxRate: number) => ({ rowId, data: { taxRate } as any });

  it("stamps a kept stored-rate-0 line that still reads 0", () => {
    const l = edit("a", 0);
    restampEditLines([l], stored, 0.0825);
    expect(l.data.taxRate).toBe(0.0825);
  });
  it("keeps a line sent at a deliberate non-zero rate, and a stored non-zero rate", () => {
    const sent = edit("a", 0.05);
    const keptStored = edit("b", 0.05);
    restampEditLines([sent, keptStored], stored, 0.0825);
    expect([sent.data.taxRate, keptStored.data.taxRate]).toEqual([0.05, 0.05]);
  });
  it("never stamps a new line (no stored row) or an NSF fee line", () => {
    const added = edit(null, 0);
    const nsf = edit("n", 0);
    restampEditLines([added, nsf], stored, 0.0825);
    expect([added.data.taxRate, nsf.data.taxRate]).toEqual([0, 0]);
  });
  it("with no verified rate nothing is stamped", () => {
    const l = edit("a", 0);
    restampEditLines([l], stored, null);
    restampEditLines([l], stored, undefined);
    expect(l.data.taxRate).toBe(0);
  });
});
