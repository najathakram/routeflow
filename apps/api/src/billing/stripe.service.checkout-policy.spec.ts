import { StripeService } from "./stripe.service";

// F1 (Stripe test-mode QA): StripeService.createCheckoutSession is a platform Checkout Session create; it
// must say Managed Payments is off and never enable automatic tax (owner ruling 2026-10-06).
describe("StripeService.createCheckoutSession - checkout policy", () => {
  it("sends managed_payments.enabled=false and no automatic tax; keeps the caller's params", async () => {
    const create = jest.fn(async () => ({ id: "cs_1", url: "https://pay.test" }));
    const svc = new StripeService({ get: () => undefined } as never);
    (svc as any).stripe = { checkout: { sessions: { create } } };

    await svc.createCheckoutSession({
      customerId: "cus_1",
      priceId: "price_1",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      metadata: { tenantId: "t1" },
    });

    const params = (create.mock.calls[0] as unknown[])[0] as Record<string, any>;
    expect(params.managed_payments).toEqual({ enabled: false });
    expect(params.automatic_tax?.enabled).not.toBe(true);
    expect(params).toMatchObject({
      customer: "cus_1",
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      metadata: { tenantId: "t1" },
    });
  });
});
