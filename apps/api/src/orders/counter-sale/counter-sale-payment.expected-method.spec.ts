import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CounterSaleDto } from "./counter-sale.dto";
import { PickupCompleteDto } from "./pickup-complete.dto";
import {
  assertPaymentShape,
  planCounterPayment,
  type CounterPaymentInput,
} from "./counter-sale-payment";

/**
 * SA-1026 Part A, the request shape. `expectedMethod: "CHECK"` rides beside `method: "ON_ACCOUNT"` and says "the check is
 * not in hand yet": no payment row, an invoice marked To collect. It is judged in `assertPaymentShape`, the one shape guard
 * the till and the hand-over share (OP-5).
 *   A-G2: a walk-in sending it gets the existing WALK_IN_NO_ACCOUNT, nothing written.
 *   A-G3: it with CASH, CARD or CHECK is the new mapped code, before any write.
 * The field is built through a cast so this spec is red on the WRONG VALUE (no refusal) on master, not on a type error.
 */
const withExpected = (method: string, extra: Partial<CounterPaymentInput> = {}) =>
  ({ method, expectedMethod: "CHECK", ...extra }) as unknown as CounterPaymentInput;

const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as { code?: string };
  }
  throw new Error("expected a BadRequestException, but nothing was thrown");
};

describe("assertPaymentShape with expectedMethod (SA-1026)", () => {
  it("A-G1 shape: ON_ACCOUNT + expectedMethod CHECK passes for a named customer, no check number needed", () => {
    expect(() => assertPaymentShape(withExpected("ON_ACCOUNT"), false)).not.toThrow();
  });

  it("A-G2: a walk-in sending ON_ACCOUNT + expectedMethod is WALK_IN_NO_ACCOUNT", () => {
    expect(codeOf(() => assertPaymentShape(withExpected("ON_ACCOUNT"), true)).code).toBe(
      "WALK_IN_NO_ACCOUNT",
    );
  });

  it.each(["CASH", "CARD", "CHECK"])(
    "A-G3: expectedMethod with %s is COUNTER_EXPECTED_METHOD_NEEDS_ON_ACCOUNT",
    (method) => {
      expect(
        codeOf(() => assertPaymentShape(withExpected(method, { reference: "1042" }), false)).code,
      ).toBe("COUNTER_EXPECTED_METHOD_NEEDS_ON_ACCOUNT");
    },
  );

  it("A-G3: a CHECK with expectedMethod and no number is the new code, not the check-number code", () => {
    expect(codeOf(() => assertPaymentShape(withExpected("CHECK"), false)).code).toBe(
      "COUNTER_EXPECTED_METHOD_NEEDS_ON_ACCOUNT",
    );
  });

  it("a CHECK without expectedMethod still needs its number (the old pin is kept)", () => {
    expect(codeOf(() => assertPaymentShape({ method: "CHECK" }, false)).code).toBe(
      "COUNTER_CHECK_NUMBER_REQUIRED",
    );
  });
});

describe("planCounterPayment: expectedMethod takes no money (the T1 rule)", () => {
  it("ON_ACCOUNT plans no payment row whatever the balance", () => {
    expect(planCounterPayment({ method: "ON_ACCOUNT", balance: 42.5 })).toEqual({ kind: "none" });
  });
});

describe("DTO edge: expectedMethod", () => {
  const ITEM = { productId: "6f1c2b9e-3a4d-4c5e-9f00-1a2b3c4d5e6f", qty: 1 };
  const fields = async (cls: new () => object, body: Record<string, unknown>) =>
    (await validate(plainToInstance(cls, body) as object, { whitelist: true })).map(
      (e) => e.property,
    );
  const payment = (extra: Record<string, unknown>) => ({ method: "ON_ACCOUNT", ...extra });

  it("the till's payment accepts expectedMethod CHECK", async () => {
    const dto = plainToInstance(CounterSaleDto, {
      customerId: "7f1c2b9e-3a4d-4c5e-9f00-1a2b3c4d5e6f",
      items: [ITEM],
      payment: payment({ expectedMethod: "CHECK" }),
    });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect((dto.payment as unknown as { expectedMethod?: string }).expectedMethod).toBe("CHECK");
  });

  it("the hand-over's payment accepts it too", async () => {
    const dto = plainToInstance(PickupCompleteDto, {
      payment: payment({ expectedMethod: "CHECK" }),
    });
    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect((dto.payment as unknown as { expectedMethod?: string }).expectedMethod).toBe("CHECK");
  });

  it.each(["CASH", "CARD", "ON_ACCOUNT", "check", ""])(
    "refuses a value outside TO_COLLECT_METHOD_VALUES (%p)",
    async (value) => {
      expect(
        await fields(CounterSaleDto, {
          walkIn: false,
          customerId: "7f1c2b9e-3a4d-4c5e-9f00-1a2b3c4d5e6f",
          items: [ITEM],
          payment: payment({ expectedMethod: value }),
        }),
      ).toContain("payment");
    },
  );
});
