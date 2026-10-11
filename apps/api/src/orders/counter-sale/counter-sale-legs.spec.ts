import { BadRequestException } from "@nestjs/common";
import {
  assertLegsAgainstTotal,
  assertLegsShape,
  resolveLegs,
  type CounterLegInput,
} from "./counter-sale-legs";

/**
 * Split-payment request rules (pure, no IO). Every refusal is a 400 with a code, raised BEFORE anything is
 * written; the limits come from TENDER_RULES.counter. Amounts are dollars on the wire, judged in cents.
 */
const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    expect((e as BadRequestException).getStatus()).toBe(400);
    return ((e as BadRequestException).getResponse() as { code?: string }).code;
  }
  return undefined;
};

const L = (method: CounterLegInput["method"], amount?: number, reference?: string) => ({
  method,
  ...(amount != null ? { amount } : {}),
  ...(reference != null ? { reference } : {}),
});

describe("resolveLegs (payment alias vs payments)", () => {
  it("the old single payment is a one-leg alias", () => {
    expect(resolveLegs({ payment: L("CASH", 20) })).toEqual([L("CASH", 20)]);
  });

  it("payments are used as sent, in order", () => {
    const legs = [L("CARD", 30), L("CASH", 50)];
    expect(resolveLegs({ payments: legs })).toEqual(legs);
  });

  it("payment together with payments is COUNTER_PAYMENT_SHAPE_CONFLICT", () => {
    expect(
      codeOf(() => resolveLegs({ payment: L("CASH", 1), payments: [L("CARD", 1), L("CASH", 1)] })),
    ).toBe("COUNTER_PAYMENT_SHAPE_CONFLICT");
  });

  it("neither is the same code", () => {
    expect(codeOf(() => resolveLegs({}))).toBe("COUNTER_PAYMENT_SHAPE_CONFLICT");
  });
});

describe("assertLegsShape (request-only refusals)", () => {
  it("more than 4 legs is COUNTER_TOO_MANY_LEGS; 4 is fine", () => {
    const five = [L("CARD", 1), L("CARD", 1), L("CHECK", 1, "1"), L("CHECK", 1, "2"), L("CASH", 1)];
    expect(codeOf(() => assertLegsShape(five, false))).toBe("COUNTER_TOO_MANY_LEGS");
    expect(codeOf(() => assertLegsShape(five.slice(0, 4), false))).toBeUndefined();
  });

  it("STORE_CREDIT is TENDER_METHOD_NOT_ALLOWED", () => {
    expect(codeOf(() => assertLegsShape([L("STORE_CREDIT", 5)], false))).toBe(
      "TENDER_METHOD_NOT_ALLOWED",
    );
    expect(codeOf(() => assertLegsShape([L("STORE_CREDIT", 5), L("CASH", 5)], false))).toBe(
      "TENDER_METHOD_NOT_ALLOWED",
    );
  });

  it("ON_ACCOUNT beside any other leg is COUNTER_ON_ACCOUNT_NOT_SPLIT; alone it is fine", () => {
    expect(codeOf(() => assertLegsShape([L("ON_ACCOUNT"), L("CASH", 5)], false))).toBe(
      "COUNTER_ON_ACCOUNT_NOT_SPLIT",
    );
    expect(codeOf(() => assertLegsShape([L("ON_ACCOUNT")], false))).toBeUndefined();
  });

  it("two CASH legs is COUNTER_DUPLICATE_CASH_LEG", () => {
    expect(codeOf(() => assertLegsShape([L("CASH", 5), L("CASH", 5)], false))).toBe(
      "COUNTER_DUPLICATE_CASH_LEG",
    );
  });

  it("a CHECK leg without a reference is COUNTER_CHECK_NUMBER_REQUIRED (also inside a split)", () => {
    expect(codeOf(() => assertLegsShape([L("CHECK", 5), L("CASH", 5)], false))).toBe(
      "COUNTER_CHECK_NUMBER_REQUIRED",
    );
    expect(codeOf(() => assertLegsShape([L("CHECK", 5, "1042"), L("CASH", 5)], false))).toBe(
      undefined,
    );
  });

  it("in a split every leg needs an amount above zero (omitted, 0 non-cash or 0 cash)", () => {
    expect(codeOf(() => assertLegsShape([L("CARD"), L("CASH", 5)], false))).toBe(
      "COUNTER_LEG_AMOUNT_REQUIRED",
    );
    expect(codeOf(() => assertLegsShape([L("CARD", 0), L("CASH", 5)], false))).toBe(
      "COUNTER_LEG_AMOUNT_REQUIRED",
    );
    expect(codeOf(() => assertLegsShape([L("CARD", 5), L("CASH", 0)], false))).toBe(
      "COUNTER_LEG_AMOUNT_REQUIRED",
    );
    expect(codeOf(() => assertLegsShape([L("CARD", 5), L("CASH")], false))).toBe(
      "COUNTER_LEG_AMOUNT_REQUIRED",
    );
  });

  it("a one-leg payment keeps today's rule: the amount may be omitted (= the exact balance)", () => {
    expect(codeOf(() => assertLegsShape([L("CARD")], false))).toBeUndefined();
    expect(codeOf(() => assertLegsShape([L("CASH", 0)], false))).toBeUndefined();
  });

  it("an amount that is not whole cents is COUNTER_LEG_NOT_CENTS, on any leg", () => {
    expect(codeOf(() => assertLegsShape([L("CARD", 10.005), L("CASH", 5)], false))).toBe(
      "COUNTER_LEG_NOT_CENTS",
    );
    expect(codeOf(() => assertLegsShape([L("CASH", 20.001)], false))).toBe("COUNTER_LEG_NOT_CENTS");
    expect(codeOf(() => assertLegsShape([L("CARD", 19.99), L("CASH", 0.29)], false))).toBe(
      undefined,
    );
  });

  it("a walk-in cannot buy on account (the existing rule still applies per leg)", () => {
    expect(codeOf(() => assertLegsShape([L("ON_ACCOUNT")], true))).toBe("WALK_IN_NO_ACCOUNT");
  });
});

describe("assertLegsAgainstTotal (the SERVER total)", () => {
  it("card 30 + cash 50 on 70 is accepted (cash may exceed: change)", () => {
    expect(() => assertLegsAgainstTotal([L("CARD", 30), L("CASH", 50)], 70, true)).not.toThrow();
    expect(() => assertLegsAgainstTotal([L("CARD", 30), L("CASH", 50)], 70, false)).not.toThrow();
  });

  it("the non-cash legs adding up past the total is COUNTER_PAYMENT_EXCEEDS_TOTAL", () => {
    expect(
      codeOf(() => assertLegsAgainstTotal([L("CARD", 50), L("CHECK", 30, "9")], 70, false)),
    ).toBe("COUNTER_PAYMENT_EXCEEDS_TOTAL");
  });

  it("a one-leg card or check above the total is the same code (before the sale is written)", () => {
    expect(codeOf(() => assertLegsAgainstTotal([L("CARD", 99)], 37.25, false))).toBe(
      "COUNTER_PAYMENT_EXCEEDS_TOTAL",
    );
    expect(() => assertLegsAgainstTotal([L("CARD", 37.25)], 37.25, false)).not.toThrow();
  });

  it("a cash leg beside non-cash legs that already cover the total is COUNTER_PAYMENT_EXCEEDS_TOTAL", () => {
    expect(codeOf(() => assertLegsAgainstTotal([L("CARD", 70), L("CASH", 5)], 70, false))).toBe(
      "COUNTER_PAYMENT_EXCEEDS_TOTAL",
    );
  });

  it("a one-leg cash may exceed the total, and a zero-total one-leg cash is not refused", () => {
    expect(() => assertLegsAgainstTotal([L("CASH", 100)], 37.25, true)).not.toThrow();
    expect(() => assertLegsAgainstTotal([L("CASH", 0)], 0, false)).not.toThrow();
  });

  it("a walk-in whose legs add up below the total is COUNTER_TENDER_SHORT", () => {
    expect(codeOf(() => assertLegsAgainstTotal([L("CARD", 30), L("CASH", 30)], 70, true))).toBe(
      "COUNTER_TENDER_SHORT",
    );
    expect(codeOf(() => assertLegsAgainstTotal([L("CASH", 0)], 37.25, true))).toBe(
      "COUNTER_TENDER_SHORT",
    );
  });

  it("a named customer may part-pay a split (the rest stays on account)", () => {
    expect(() => assertLegsAgainstTotal([L("CARD", 30), L("CASH", 10)], 70, false)).not.toThrow();
  });

  it("an omitted one-leg amount is the exact total; ON_ACCOUNT is never judged", () => {
    expect(() => assertLegsAgainstTotal([L("CARD")], 37.25, true)).not.toThrow();
    expect(() => assertLegsAgainstTotal([L("ON_ACCOUNT")], 37.25, false)).not.toThrow();
  });

  it("is judged in cents: 0.1 + 0.2 style float sums do not trip it", () => {
    expect(() =>
      assertLegsAgainstTotal([L("CARD", 0.1), L("CHECK", 0.2, "1"), L("CASH", 5)], 5.3, true),
    ).not.toThrow();
  });
});
