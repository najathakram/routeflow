import { Logger } from "@nestjs/common";
import {
  CHECKOUT_PAYMENT_METHODS_ENV,
  CheckoutPolicyViolation,
  checkoutPaymentMethodTypes,
  withCheckoutPolicy,
} from "./checkout-session-params";

const BASE = {
  mode: "subscription" as const,
  customer: "cus_1",
  line_items: [{ price: "price_1", quantity: 1 }],
  success_url: "https://app.test/ok",
  cancel_url: "https://app.test/no",
  metadata: { tenantId: "t1" },
  subscription_data: { trial_end: 1_800_000_000 },
};

describe("withCheckoutPolicy (owner ruling 2026-10-06: Managed Payments off, no tax)", () => {
  it("sets managed_payments.enabled=false and preserves every other param", () => {
    const out = withCheckoutPolicy(BASE);
    expect(out.managed_payments).toEqual({ enabled: false });
    expect(out).toEqual({ ...BASE, managed_payments: { enabled: false } });
  });

  it("does not mutate the caller's object", () => {
    const input = { ...BASE };
    withCheckoutPolicy(input);
    expect(input).not.toHaveProperty("managed_payments");
  });

  it("is idempotent when managed_payments is already off", () => {
    const once = withCheckoutPolicy(BASE);
    expect(withCheckoutPolicy(once)).toEqual(once);
    expect(withCheckoutPolicy({ ...BASE, managed_payments: { enabled: false } })).toEqual(once);
  });

  it("accepts automatic_tax absent or { enabled: false }", () => {
    expect(() => withCheckoutPolicy(BASE)).not.toThrow();
    const out = withCheckoutPolicy({ ...BASE, automatic_tax: { enabled: false } });
    expect(out.automatic_tax).toEqual({ enabled: false });
  });

  it("throws when a caller asks for automatic tax", () => {
    expect(() => withCheckoutPolicy({ ...BASE, automatic_tax: { enabled: true } })).toThrow(
      CheckoutPolicyViolation,
    );
  });

  it("throws when a caller asks for Managed Payments on", () => {
    expect(() => withCheckoutPolicy({ ...BASE, managed_payments: { enabled: true } })).toThrow(
      CheckoutPolicyViolation,
    );
  });
});

describe("checkoutPaymentMethodTypes (SA-1037 r3 PR-1: payment methods by config, default = today)", () => {
  const env = (v?: string) => ({ [CHECKOUT_PAYMENT_METHODS_ENV]: v });

  it("unset, empty or blank: undefined, so the field is omitted and the Dashboard decides", () => {
    expect(checkoutPaymentMethodTypes({})).toBeUndefined();
    expect(checkoutPaymentMethodTypes(env(""))).toBeUndefined();
    expect(checkoutPaymentMethodTypes(env("   "))).toBeUndefined();
  });

  it("card_and_bank: card and us_bank_account (case and spaces tolerated)", () => {
    expect(checkoutPaymentMethodTypes(env("card_and_bank"))).toEqual(["card", "us_bank_account"]);
    expect(checkoutPaymentMethodTypes(env("  Card_And_Bank "))).toEqual([
      "card",
      "us_bank_account",
    ]);
  });

  it("an unknown value omits the field and warns once per value, never throws", () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      expect(checkoutPaymentMethodTypes(env("ach_only_typo"))).toBeUndefined();
      expect(checkoutPaymentMethodTypes(env("ach_only_typo"))).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(CHECKOUT_PAYMENT_METHODS_ENV);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns a fresh array each call (a caller cannot corrupt the set)", () => {
    const a = checkoutPaymentMethodTypes(env("card_and_bank"))!;
    a.push("link" as never);
    expect(checkoutPaymentMethodTypes(env("card_and_bank"))).toEqual(["card", "us_bank_account"]);
  });
});

describe("withCheckoutPolicy x BILLING_CHECKOUT_PAYMENT_METHODS (R1)", () => {
  const prior = process.env[CHECKOUT_PAYMENT_METHODS_ENV];
  afterEach(() => {
    if (prior === undefined) delete process.env[CHECKOUT_PAYMENT_METHODS_ENV];
    else process.env[CHECKOUT_PAYMENT_METHODS_ENV] = prior;
  });

  it("env unset: no payment_method_types key at all (today)", () => {
    delete process.env[CHECKOUT_PAYMENT_METHODS_ENV];
    expect(withCheckoutPolicy(BASE)).not.toHaveProperty("payment_method_types");
  });

  it("env card_and_bank: the session carries card + us_bank_account, every other param untouched", () => {
    process.env[CHECKOUT_PAYMENT_METHODS_ENV] = "card_and_bank";
    const out = withCheckoutPolicy(BASE);
    expect(out.payment_method_types).toEqual(["card", "us_bank_account"]);
    expect(out).toEqual({
      ...BASE,
      payment_method_types: ["card", "us_bank_account"],
      managed_payments: { enabled: false },
    });
  });

  it("a caller that names its own payment_method_types keeps them (the env is only the default)", () => {
    process.env[CHECKOUT_PAYMENT_METHODS_ENV] = "card_and_bank";
    expect(
      withCheckoutPolicy({ ...BASE, payment_method_types: ["card"] }).payment_method_types,
    ).toEqual(["card"]);
  });

  it("is idempotent with the env set", () => {
    process.env[CHECKOUT_PAYMENT_METHODS_ENV] = "card_and_bank";
    const once = withCheckoutPolicy(BASE);
    expect(withCheckoutPolicy(once)).toEqual(once);
  });
});
