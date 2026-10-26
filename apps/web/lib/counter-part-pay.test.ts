import {
  PART_PAY_AMOUNT_COPY,
  PART_PAY_FULL_COPY,
  PART_PAY_CREDIT_PENDING_COPY,
  PART_PAY_CREDIT_FAILED_COPY,
  PART_PAY_CREDIT_COVERS_COPY,
  isPartPayProblemCopy,
  PART_PAY_OVER_TOTAL_COPY,
  partPayOverCreditCopy,
  partPayEqualsTotal,
  creditMayApply,
  counterPaymentAmount,
  partPayAmountProblem,
  partPayCopy,
  partPaySplit,
} from "./counter-part-pay";
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

  it("with credit that may apply it states no remainder; creditMayApply reads the server figure", () => {
    const split = partPaySplit({ method: "CASH", isWalkIn: false, total: 12.5, tendered: 5 });
    expect(partPayCopy(split!, true)).toBe(
      "Pay $5.00 now · the rest goes on account, less any credit applied",
    );
    expect(creditMayApply({ state: "ready", value: 0 })).toBe(false);
    expect(creditMayApply({ state: "ready", value: 4 })).toBe(true);
    expect(creditMayApply({ state: "failed" })).toBe(true);
    expect(creditMayApply({ state: "loading" })).toBe(true);
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

describe("partPayAmountProblem: Amount paying now that is not a positive number", () => {
  const input = (tendered: string) => ({ method: "CARD" as const, isWalkIn: false, tendered });

  it("blank or spaces is a full payment, not a problem", () => {
    expect(partPayAmountProblem(input(""))).toBeNull();
    expect(partPayAmountProblem(input("   "))).toBeNull();
  });

  it("zero, negative, comma-decimal and text are refused with the one sentence", () => {
    for (const bad of ["0", "0.00", "-5", "5,00", "abc", "5 dollars", "1e2", "--"]) {
      expect(partPayAmountProblem(input(bad))).toBe(PART_PAY_AMOUNT_COPY);
    }
    expect(PART_PAY_AMOUNT_COPY).toBe(
      "Enter an amount above zero, or leave it empty to pay in full.",
    );
  });

  it("positive amounts pass, and exactly the total is a full payment", () => {
    for (const ok of ["5", "5.5", "5.05", ".5", "12.50", "400"]) {
      expect(partPayAmountProblem(input(ok))).toBeNull();
    }
    expect(partPayAmountProblem({ ...input("20"), total: 20 })).toBeNull();
    expect(partPayAmountProblem({ ...input("19.99"), total: 20 })).toBeNull();
  });

  it("an amount strictly above the total is refused (the server's COUNTER_PAYMENT_EXCEEDS_TOTAL), not silently a full payment", () => {
    for (const method of ["CARD", "CHECK"] as const) {
      expect(partPayAmountProblem({ method, isWalkIn: false, tendered: "20.01", total: 20 })).toBe(
        PART_PAY_OVER_TOTAL_COPY,
      );
      expect(partPayAmountProblem({ method, isWalkIn: false, tendered: "400", total: 20 })).toBe(
        PART_PAY_OVER_TOTAL_COPY,
      );
    }
    expect(PART_PAY_OVER_TOTAL_COPY).toBe(
      "Amount paying now can't be more than the total. Lower it, or leave it empty to pay in full.",
    );
  });

  it("cash, on account and a walk-in are not subject to the over-total refusal", () => {
    for (const method of ["CASH", "ON_ACCOUNT"] as const) {
      expect(
        partPayAmountProblem({ method, isWalkIn: false, tendered: "400", total: 20 }),
      ).toBeNull();
    }
    expect(
      partPayAmountProblem({ method: "CARD", isWalkIn: true, tendered: "400", total: 20 }),
    ).toBeNull();
  });

  it("only applies to an identified customer's CHECK or CARD", () => {
    expect(partPayAmountProblem({ method: "CASH", isWalkIn: false, tendered: "abc" })).toBeNull();
    expect(
      partPayAmountProblem({ method: "ON_ACCOUNT", isWalkIn: false, tendered: "abc" }),
    ).toBeNull();
    expect(partPayAmountProblem({ method: "CARD", isWalkIn: true, tendered: "abc" })).toBeNull();
    expect(partPayAmountProblem({ method: "CHECK", isWalkIn: false, tendered: "abc" })).toBe(
      PART_PAY_AMOUNT_COPY,
    );
  });
});

describe("partPayEqualsTotal: a typed amount equal to the total is said to be a full payment", () => {
  const base = { method: "CARD" as const, isWalkIn: false, total: 20 };
  it("true only for check/card of an identified customer at exactly the total", () => {
    expect(partPayEqualsTotal({ ...base, tendered: 20 })).toBe(true);
    expect(partPayEqualsTotal({ ...base, method: "CHECK", tendered: 20 })).toBe(true);
    expect(partPayEqualsTotal({ ...base, tendered: 19.99 })).toBe(false);
    expect(partPayEqualsTotal({ ...base, tendered: 0 })).toBe(false);
    expect(partPayEqualsTotal({ ...base, method: "CASH", tendered: 20 })).toBe(false);
    expect(partPayEqualsTotal({ ...base, isWalkIn: true, tendered: 20 })).toBe(false);
    expect(PART_PAY_FULL_COPY).toBe("That is the full total, so it pays in full.");
  });
});

describe("partPayAmountProblem with the customer's open credit (server parity)", () => {
  const at = (
    tendered: string,
    availableCredit: number | null | "failed",
    method: "CARD" | "CHECK" | "CASH" = "CARD",
  ) => partPayAmountProblem({ method, isWalkIn: false, tendered, total: 100, availableCredit });

  it("$95 against $100 with $10 credit is refused before submit; the cap is total minus credit", () => {
    expect(at("95", 10)).toBe(partPayOverCreditCopy(90));
    expect(at("90.01", 10, "CHECK")).toBe(partPayOverCreditCopy(90));
    expect(at("90", 10)).toBeNull();
    expect(at("50", 10)).toBeNull();
    expect(partPayOverCreditCopy(90)).toContain("$90.00");
  });

  it("exactly the total is still a full payment (it states no amount), and above it is over the total", () => {
    expect(at("100", 10)).toBeNull();
    expect(at("100.01", 10)).toBe(PART_PAY_OVER_TOTAL_COPY);
  });

  it("with no credit the cap is the total, as before", () => {
    expect(at("95", 0)).toBeNull();
  });

  it("exactly the total is a full payment in EVERY credit state, unknown included", () => {
    for (const method of ["CARD", "CHECK"] as const) {
      expect(at("100", null, method)).toBeNull();
      expect(at("100.00", null, method)).toBeNull();
    }
  });

  it("a FAILED credit read is its own refusal (visible, with a way out), never the waiting copy", () => {
    expect(at("50", "failed")).toBe(PART_PAY_CREDIT_FAILED_COPY);
    expect(PART_PAY_CREDIT_FAILED_COPY).not.toBe(PART_PAY_CREDIT_PENDING_COPY);
    expect(at("100", "failed")).toBeNull(); // exactly the total is full in every credit state
    expect(at("", "failed")).toBeNull();
    expect(at("50", "failed", "CASH")).toBeNull();
  });

  it("credit that covers the whole sale says so instead of 'most you can pay is $0.00'", () => {
    for (const credit of [100, 140]) {
      const p = at("40", credit);
      expect(p).toBe(PART_PAY_CREDIT_COVERS_COPY);
      expect(p).not.toContain("$0.00");
    }
    expect(PART_PAY_CREDIT_COVERS_COPY).toBe(
      "Credit on the account covers this sale, so nothing is due now. Leave Amount paying now empty.",
    );
  });

  it("isPartPayProblemCopy recognises every Amount paying now refusal (so editing the field clears it)", () => {
    for (const c of [
      PART_PAY_AMOUNT_COPY,
      PART_PAY_OVER_TOTAL_COPY,
      PART_PAY_CREDIT_PENDING_COPY,
      PART_PAY_CREDIT_FAILED_COPY,
      PART_PAY_CREDIT_COVERS_COPY,
      partPayOverCreditCopy(90),
    ]) {
      expect(isPartPayProblemCopy(c)).toBe(true);
    }
    expect(isPartPayProblemCopy("Enter the check number.")).toBe(false);
  });

  it("an unknown credit blocks a typed check/card part, but not a blank (full) or cash", () => {
    expect(at("50", null)).toBe(PART_PAY_CREDIT_PENDING_COPY);
    expect(at("", null)).toBeNull();
    expect(at("95", null, "CASH")).toBeNull();
  });
});
