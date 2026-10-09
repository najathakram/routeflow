import { BillingService } from "./billing.service";

/**
 * SA-733r3 N2: BillingService.handleWebhookEvent hands the catch-up events to the claim service - and an absent
 * claim service (a spec / script wiring) changes nothing. The claim service itself: catchup-claim.service.spec.ts.
 */
function make() {
  const catchup = {
    onSessionCompleted: jest.fn().mockResolvedValue(undefined),
    onSessionExpired: jest.fn().mockResolvedValue(undefined),
    onInvoicePaid: jest.fn().mockResolvedValue(undefined),
    onOrdinaryConversionPaid: jest.fn().mockResolvedValue(false),
    onPaymentFailed: jest.fn().mockResolvedValue(undefined),
  };
  const billing = new BillingService(
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    catchup as any,
  );
  // the ordinary handlers are not under test here
  const ordinary = jest.fn().mockResolvedValue(undefined);
  (billing as any).onCheckoutCompleted = ordinary;
  (billing as any).onPaymentFailed = ordinary;
  return { billing, catchup, ordinary };
}

const ev = (type: string, object: any = { id: "x" }) => ({ id: "evt_1", type, data: { object } });

describe("catch-up webhook routing", () => {
  it("checkout.session.completed: the ordinary handler FIRST, then the claim advance (it only acts on what was applied)", async () => {
    const { billing, catchup, ordinary } = make();
    const order: string[] = [];
    ordinary.mockImplementation(async () => void order.push("ordinary"));
    catchup.onSessionCompleted.mockImplementation(async () => void order.push("catchup"));
    await billing.handleWebhookEvent(ev("checkout.session.completed", { id: "cs_1" }));
    expect(order).toEqual(["ordinary", "catchup"]);
    expect(catchup.onSessionCompleted).toHaveBeenCalledWith({ id: "cs_1" });
  });

  it("a failing ordinary completion fails the webhook BEFORE the claim is touched (Stripe redelivers)", async () => {
    const { billing, catchup, ordinary } = make();
    ordinary.mockRejectedValueOnce(new Error("boom"));
    await expect(billing.handleWebhookEvent(ev("checkout.session.completed"))).rejects.toThrow(
      "boom",
    );
    expect(catchup.onSessionCompleted).not.toHaveBeenCalled();
  });

  it("checkout.session.expired -> onSessionExpired; invoice.paid -> onInvoicePaid, then the ordinary-checkout conversion", async () => {
    const { billing, catchup } = make();
    await billing.handleWebhookEvent(ev("checkout.session.expired", { id: "cs_1" }));
    await billing.handleWebhookEvent(ev("invoice.paid", { id: "in_1" }));
    expect(catchup.onSessionExpired).toHaveBeenCalledWith({ id: "cs_1" });
    expect(catchup.onInvoicePaid).toHaveBeenCalledWith({ id: "in_1" });
    expect(catchup.onOrdinaryConversionPaid).toHaveBeenCalledWith({ id: "in_1" });
  });

  it("invoice.payment_failed -> the claim hook, then the ordinary handler", async () => {
    const { billing, catchup, ordinary } = make();
    const order: string[] = [];
    catchup.onPaymentFailed.mockImplementation(async () => void order.push("catchup"));
    ordinary.mockImplementation(async () => void order.push("ordinary"));
    await billing.handleWebhookEvent(ev("invoice.payment_failed", { id: "in_1" }));
    expect(order).toEqual(["catchup", "ordinary"]);
  });

  it("without a claim service wired, the same events are harmless", async () => {
    const billing = new BillingService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    (billing as any).onCheckoutCompleted = jest.fn();
    await expect(
      billing.handleWebhookEvent(ev("checkout.session.expired")),
    ).resolves.toBeUndefined();
    await expect(billing.handleWebhookEvent(ev("invoice.paid"))).resolves.toBeUndefined();
    await expect(
      billing.handleWebhookEvent(ev("checkout.session.completed")),
    ).resolves.toBeUndefined();
  });
});

describe("a Stripe `trialing` catch-up subscription (r R16-3 / r3 N3): the tenant stays ACTIVE, no trial email", () => {
  function makeUpdated() {
    const prisma: any = {
      tenantSubscription: {
        findFirst: jest.fn(async () => ({
          tenantId: "t1",
          stripeSubId: "sub_1",
          stripeCustomerId: "cus_1",
          tenant: { id: "t1", slug: "qa-acme", name: "Acme" },
        })),
        update: jest.fn().mockResolvedValue({}),
      },
      tenant: { updateMany: jest.fn(), update: jest.fn() },
      tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const notification: any = {
      notifySuspended: jest.fn(),
      notifyCancelled: jest.fn(),
      notifyTrialEnding: jest.fn(),
    };
    const email: any = { send: jest.fn() };
    const billing = new BillingService(
      prisma,
      {} as any,
      email,
      { invalidate: jest.fn() } as any,
      { emit: jest.fn() } as any,
      {} as any,
      notification,
      {} as any,
      {} as any,
    );
    // the coupon re-derive (b2b) reads Stripe + the DB clock: not under test here, only that it still runs
    const syncCoupon = jest.fn().mockResolvedValue(undefined);
    (billing as any).syncCoupon = syncCoupon;
    return { billing, prisma, notification, email, syncCoupon };
  }

  it("customer.subscription.updated with status trialing (catchup=period too) writes the period + cancel flag only - no tenant status, no email", async () => {
    const h = makeUpdated();
    await h.billing.handleWebhookEvent({
      id: "evt_1",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "trialing",
          cancel_at_period_end: false,
          metadata: { catchup: "period" },
          trial_end: 1793534400,
          items: {
            data: [
              { id: "si_1", current_period_start: 1790856000, current_period_end: 1793534400 },
            ],
          },
        },
      },
    });
    expect(h.prisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(h.prisma.tenant.update).not.toHaveBeenCalled();
    expect(h.notification.notifySuspended).not.toHaveBeenCalled();
    expect(h.notification.notifyCancelled).not.toHaveBeenCalled();
    expect(h.notification.notifyTrialEnding).not.toHaveBeenCalled();
    expect(h.email.send).not.toHaveBeenCalled();
    const written = h.prisma.tenantSubscription.update.mock.calls[0][0].data;
    expect(Object.keys(written).sort()).toEqual(["cancelAtPeriodEnd", "periodEnd", "periodStart"]);
    expect(h.syncCoupon).toHaveBeenCalledTimes(1);
  });

  it("customer.subscription.trial_will_end has no handler: Stripe's trial reminder never becomes our email", async () => {
    const h = makeUpdated();
    await h.billing.handleWebhookEvent({
      id: "evt_2",
      type: "customer.subscription.trial_will_end",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_1",
          status: "trialing",
          metadata: { catchup: "period" },
        },
      },
    });
    expect(h.notification.notifyTrialEnding).not.toHaveBeenCalled();
    expect(h.email.send).not.toHaveBeenCalled();
    expect(h.prisma.tenantSubscription.update).not.toHaveBeenCalled();
  });
});
