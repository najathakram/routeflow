import { StripeService } from "./stripe.service";

// #2476 Opus MED fold: createBillingPortalSession forwards per-request options to stripe-node only
// when a caller asks for them (the payment-failed email caps its call; the portal endpoint does not).
describe("#2476 StripeService.createBillingPortalSession request options", () => {
  function make() {
    const create = jest.fn(async () => ({ url: "https://billing.stripe.test/p/s" }));
    const svc = new StripeService({ get: () => undefined } as never);
    (svc as any).stripe = { billingPortal: { sessions: { create } } };
    return { svc, create };
  }

  it("forwards a cap as stripe-node's { timeout, maxNetworkRetries }", async () => {
    const { svc, create } = make();
    await svc.createBillingPortalSession(
      { customerId: "cus_1", returnUrl: "https://app.test/settings/billing" },
      { timeoutMs: 10_000, maxNetworkRetries: 0 },
    );
    expect(create).toHaveBeenCalledWith(
      { customer: "cus_1", return_url: "https://app.test/settings/billing" },
      { timeout: 10_000, maxNetworkRetries: 0 },
    );
  });

  it("without options it passes none (Stripe's defaults)", async () => {
    const { svc, create } = make();
    await svc.createBillingPortalSession({ customerId: "cus_1", returnUrl: "https://app.test/x" });
    expect((create.mock.calls[0] as unknown[])[1]).toBeUndefined();
  });
});
