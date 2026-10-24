import { CheckoutPolicyViolation, withCheckoutPolicy } from "./checkout-session-params";

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
