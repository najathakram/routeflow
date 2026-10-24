import { counterPaymentAmount, partPayCopy, partPaySplit } from "./counter-part-pay";
import { resolveCounterDefaultTender } from "./counter-default-tender";

/**
 * SA-933 / W-822(a) S4: an IDENTIFIED customer can pay part now (cash, check or card) and the rest goes on account; a walk-in
 * still pays the full total. The server already allows it (planCounterPayment: below the balance is a partial payment; only
 * a walk-in is held to the total, assertWalkInTenderCoversTotal).
 */
describe("counterPaymentAmount: what the payment body carries (S4)", () => {
  const sale = { total: 12.5, isWalkIn: false };

  it("CASH always carries the tendered amount (unchanged)", () => {
    expect(counterPaymentAmount({ ...sale, method: "CASH", tendered: 5 })).toEqual({ amount: 5 });
    expect(counterPaymentAmount({ ...sale, method: "CASH", tendered: 20 })).toEqual({ amount: 20 });
    expect(
      counterPaymentAmount({ ...sale, isWalkIn: true, method: "CASH", tendered: 12.5 }),
    ).toEqual({
      amount: 12.5,
    });
  });

  it("CHECK and CARD carry the amount only for a part payment by an identified customer", () => {
    for (const method of ["CHECK", "CARD"] as const) {
      expect(counterPaymentAmount({ ...sale, method, tendered: 5 })).toEqual({ amount: 5 });
      expect(counterPaymentAmount({ ...sale, method, tendered: 5.005 })).toEqual({ amount: 5.01 });
    }
  });

  it("a FULL CHECK or CARD payment leaves the amount out, as it does today", () => {
    for (const method of ["CHECK", "CARD"] as const) {
      expect(counterPaymentAmount({ ...sale, method, tendered: 0 })).toEqual({});
      expect(counterPaymentAmount({ ...sale, method, tendered: 12.5 })).toEqual({});
      expect(counterPaymentAmount({ ...sale, method, tendered: 40 })).toEqual({});
    }
  });

  it("a walk-in's CHECK or CARD never carries an amount, and ON_ACCOUNT never does", () => {
    expect(
      counterPaymentAmount({ total: 12.5, isWalkIn: true, method: "CARD", tendered: 5 }),
    ).toEqual({});
    expect(
      counterPaymentAmount({ total: 12.5, isWalkIn: true, method: "CHECK", tendered: 5 }),
    ).toEqual({});
    expect(counterPaymentAmount({ ...sale, method: "ON_ACCOUNT", tendered: 5 })).toEqual({});
  });
});

describe("partPaySplit / partPayCopy: the S4 split label", () => {
  it("names what is paid now and what goes on account, money formatted to the cent", () => {
    const split = partPaySplit({ method: "CASH", isWalkIn: false, total: 12.5, tendered: 5 });
    expect(split).toEqual({ now: 5, onAccount: 7.5 });
    expect(partPayCopy(split!)).toBe("Pay $5.00 now · $7.50 goes on account");
  });

  it("works for a check or a card part payment and rounds the pieces", () => {
    const split = partPaySplit({ method: "CARD", isWalkIn: false, total: 10.1, tendered: 3.3 });
    expect(split).toEqual({ now: 3.3, onAccount: 6.8 });
    expect(partPayCopy(split!)).toBe("Pay $3.30 now · $6.80 goes on account");
  });

  it("is null while the tender is not short, for a walk-in, for nothing tendered, and for on-account", () => {
    expect(
      partPaySplit({ method: "CASH", isWalkIn: false, total: 12.5, tendered: 12.5 }),
    ).toBeNull();
    expect(partPaySplit({ method: "CASH", isWalkIn: false, total: 12.5, tendered: 20 })).toBeNull();
    expect(partPaySplit({ method: "CASH", isWalkIn: false, total: 12.5, tendered: 0 })).toBeNull();
    expect(partPaySplit({ method: "CASH", isWalkIn: true, total: 12.5, tendered: 5 })).toBeNull();
    expect(partPaySplit({ method: "CHECK", isWalkIn: true, total: 12.5, tendered: 5 })).toBeNull();
    expect(
      partPaySplit({ method: "ON_ACCOUNT", isWalkIn: false, total: 12.5, tendered: 5 }),
    ).toBeNull();
  });
});

describe("resolveCounterDefaultTender: when the default is known (SA-933)", () => {
  const ready = (data: unknown) => ({ state: "ready" as const, data });
  const loading = { state: "loading" as const };
  const failed = { state: "failed" as const };

  it("no customer is CASH at once, with nothing to wait for", () => {
    expect(
      resolveCounterDefaultTender({ customerId: null, customer: loading, settings: loading }),
    ).toBe("CASH");
  });

  it("uses the customer's own terms without waiting for the tenant default", () => {
    expect(
      resolveCounterDefaultTender({
        customerId: "c1",
        customer: ready({ defaultPaymentTerms: "Net 30" }),
        settings: loading,
      }),
    ).toBe("ON_ACCOUNT");
    expect(
      resolveCounterDefaultTender({
        customerId: "c1",
        customer: ready({ defaultPaymentTerms: "Due on Receipt" }),
        settings: failed,
      }),
    ).toBe("CASH");
  });

  it("falls back to the tenant default when the customer has none of their own", () => {
    expect(
      resolveCounterDefaultTender({
        customerId: "c1",
        customer: ready({ defaultPaymentTerms: "" }),
        settings: ready({ defaultTerms: "Net 15" }),
      }),
    ).toBe("ON_ACCOUNT");
    expect(
      resolveCounterDefaultTender({
        customerId: "c1",
        customer: ready({ defaultPaymentTerms: null }),
        settings: ready({ defaultTerms: "Due on Receipt" }),
      }),
    ).toBe("CASH");
  });

  it("is unknown (null: change nothing) until the reads that decide it have answered", () => {
    expect(
      resolveCounterDefaultTender({
        customerId: "c1",
        customer: loading,
        settings: ready({ defaultTerms: "Net 30" }),
      }),
    ).toBeNull();
    expect(
      resolveCounterDefaultTender({
        customerId: "c1",
        customer: failed,
        settings: ready({ defaultTerms: "Net 30" }),
      }),
    ).toBeNull();
    expect(
      resolveCounterDefaultTender({ customerId: "c1", customer: ready({}), settings: loading }),
    ).toBeNull();
    expect(
      resolveCounterDefaultTender({ customerId: "c1", customer: ready({}), settings: failed }),
    ).toBeNull();
    // a settings body without a default is not an answer
    expect(
      resolveCounterDefaultTender({
        customerId: "c1",
        customer: ready({}),
        settings: ready({ taxRate: 0 }),
      }),
    ).toBeNull();
  });
});
