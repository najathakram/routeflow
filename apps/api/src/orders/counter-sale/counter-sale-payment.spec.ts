import { BadRequestException } from "@nestjs/common";
import {
  allocateOldestFirst,
  assertPaymentShape,
  planCounterPayment,
  toPrismaMethod,
} from "./counter-sale-payment";

/**
 * Counter sale payment rules (SA-655). Shape checks run BEFORE anything is written; the tender
 * checks need the server-computed POST-send balance, so `planCounterPayment` is a pure decision the
 * service takes after the sale commits. Fixtures are plain numbers, no tenant data.
 */
const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as { code?: string };
  }
  throw new Error("expected a BadRequestException");
};

describe("assertPaymentShape (pre-create)", () => {
  it("a CHECK needs a check number", () => {
    expect(codeOf(() => assertPaymentShape({ method: "CHECK" }, false)).code).toBe(
      "COUNTER_CHECK_NUMBER_REQUIRED",
    );
    expect(
      codeOf(() => assertPaymentShape({ method: "CHECK", reference: "   " }, false)).code,
    ).toBe("COUNTER_CHECK_NUMBER_REQUIRED");
    expect(() => assertPaymentShape({ method: "CHECK", reference: "1042" }, false)).not.toThrow();
  });

  it("a walk-in cannot buy on account; a named customer can", () => {
    expect(codeOf(() => assertPaymentShape({ method: "ON_ACCOUNT" }, true)).code).toBe(
      "WALK_IN_NO_ACCOUNT",
    );
    expect(() => assertPaymentShape({ method: "ON_ACCOUNT" }, false)).not.toThrow();
  });

  it("a negative or non-finite amount is a 400", () => {
    expect(() => assertPaymentShape({ method: "CASH", amount: -1 }, false)).toThrow(
      BadRequestException,
    );
    expect(() => assertPaymentShape({ method: "CASH", amount: Number.NaN }, false)).toThrow(
      BadRequestException,
    );
    expect(() => assertPaymentShape({ method: "CASH", amount: 0 }, false)).not.toThrow();
  });
});

describe("toPrismaMethod", () => {
  it("CARD is stored as CREDIT_CARD; CASH and CHECK are unchanged; ON_ACCOUNT has no payment", () => {
    expect(toPrismaMethod("CARD")).toBe("CREDIT_CARD");
    expect(toPrismaMethod("CASH")).toBe("CASH");
    expect(toPrismaMethod("CHECK")).toBe("CHECK");
    expect(toPrismaMethod("ON_ACCOUNT")).toBeNull();
  });
});

describe("planCounterPayment (against the POST-send balance)", () => {
  it("CASH tendered above the balance pays the balance and reports the change", () => {
    expect(planCounterPayment({ method: "CASH", amount: 50, balance: 37.25 })).toEqual({
      kind: "pay",
      amount: 37.25,
      tendered: 50,
    });
  });

  it("CASH with no amount is the exact balance", () => {
    expect(planCounterPayment({ method: "CASH", balance: 37.25 })).toEqual({
      kind: "pay",
      amount: 37.25,
      tendered: 37.25,
    });
  });

  it("CASH below the balance is a PARTIAL payment of exactly what was tendered (no change)", () => {
    expect(planCounterPayment({ method: "CASH", amount: 30, balance: 37.25 })).toEqual({
      kind: "pay",
      amount: 30,
      tendered: 30,
    });
  });

  it("a zero tender is refused as TENDER_SHORT for CASH, CARD and CHECK", () => {
    for (const method of ["CASH", "CARD", "CHECK"] as const) {
      expect(planCounterPayment({ method, amount: 0, balance: 37.25 })).toEqual({
        kind: "refuse",
        code: "COUNTER_TENDER_SHORT",
      });
    }
  });

  it("CARD / CHECK: omitted = exact; above is COUNTER_PAYMENT_EXCEEDS_TOTAL; below is a partial", () => {
    for (const method of ["CARD", "CHECK"] as const) {
      expect(planCounterPayment({ method, balance: 12.5 })).toMatchObject({
        kind: "pay",
        amount: 12.5,
      });
      expect(planCounterPayment({ method, amount: 12.5, balance: 12.5 })).toMatchObject({
        kind: "pay",
        amount: 12.5,
      });
      expect(planCounterPayment({ method, amount: 13, balance: 12.5 })).toEqual({
        kind: "refuse",
        code: "COUNTER_PAYMENT_EXCEEDS_TOTAL",
      });
      expect(planCounterPayment({ method, amount: 10, balance: 12.5 })).toEqual({
        kind: "pay",
        amount: 10,
        tendered: 10,
      });
    }
  });

  it("rounds to cents before comparing (0.1 + 0.2 style float dust never refuses an exact tender)", () => {
    expect(planCounterPayment({ method: "CASH", amount: 0.3, balance: 0.1 + 0.2 })).toMatchObject({
      kind: "pay",
      amount: 0.3,
    });
  });

  it("ON_ACCOUNT, or nothing left to pay (credit covered it), records no payment", () => {
    expect(planCounterPayment({ method: "ON_ACCOUNT", balance: 20 })).toEqual({ kind: "none" });
    expect(planCounterPayment({ method: "CASH", amount: 5, balance: 0 })).toEqual({ kind: "none" });
  });
});

describe("allocateOldestFirst (a mixed regulated order's sibling invoices)", () => {
  const siblings = [
    { id: "inv-1", balance: 30 },
    { id: "inv-2", balance: 7.25 },
  ];
  it("settles the oldest invoice first and never over-allocates", () => {
    expect(allocateOldestFirst(siblings, 37.25)).toEqual([
      { invoiceId: "inv-1", amount: 30 },
      { invoiceId: "inv-2", amount: 7.25 },
    ]);
    expect(allocateOldestFirst(siblings, 12)).toEqual([{ invoiceId: "inv-1", amount: 12 }]);
  });
  it("skips an invoice with nothing owing", () => {
    expect(
      allocateOldestFirst(
        [
          { id: "a", balance: 0 },
          { id: "b", balance: 4 },
        ],
        4,
      ),
    ).toEqual([{ invoiceId: "b", amount: 4 }]);
  });
});
