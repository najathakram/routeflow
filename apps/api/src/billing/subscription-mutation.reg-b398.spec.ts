import { ServiceUnavailableException } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

/**
 * REG-B398 (SA-1167 R5): an in-app cancel only flipped our local `cancelAtPeriodEnd` and never told Stripe,
 * so the Stripe subscription kept invoicing. The wrong value is a cancel that resolves with Stripe never
 * asked to stop. Collaborators are mocked at the module boundary; the service is built positionally, as
 * every sibling spec does.
 */
const DAY = 24 * 60 * 60 * 1000;

function make(stripeSubId: string | null) {
  const sub = {
    planKey: "BUSINESS",
    cycle: "MONTHLY",
    periodEnd: new Date(Date.now() + 15 * DAY),
    cancelAtPeriodEnd: false,
    stripeSubId,
  };
  const tx = {
    tenantSubscription: { update: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: "ACTIVE", class: "PRODUCTION", trialEndsAt: null }),
    },
    tenantSubscription: { findUnique: jest.fn().mockResolvedValue(sub) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const events = { emit: jest.fn().mockResolvedValue({}) };
  const stripe = {
    isConfigured: true,
    updateSubscription: jest.fn().mockResolvedValue({}),
  };
  const svc = new SubscriptionMutationService(
    prisma as any,
    {} as any,
    {} as any,
    { getSubscription: jest.fn().mockResolvedValue({}) } as any,
    { invalidate: jest.fn() } as any,
    events as any,
    { invalidate: jest.fn() } as any,
    stripe as any,
    {} as any,
    {} as any,
  );
  return { svc, tx, events, stripe };
}

describe("SubscriptionMutationService.cancel propagates to Stripe", () => {
  it("REG-B398: an ACTIVE Stripe-billed cancel tells Stripe cancel_at_period_end BEFORE the local write", async () => {
    const { svc, tx, events, stripe } = make("sub_acme_1");

    await svc.cancel("t-acme", "u-1");

    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    expect(stripe.updateSubscription).toHaveBeenCalledWith("sub_acme_1", {
      cancel_at_period_end: true,
    });
    expect(stripe.updateSubscription.mock.invocationCallOrder[0]).toBeLessThan(
      tx.tenantSubscription.update.mock.invocationCallOrder[0],
    );
    expect(tx.tenantSubscription.update.mock.calls[0][0].data).toMatchObject({
      cancelAtPeriodEnd: true,
    });
    expect(events.emit.mock.calls.map((c: unknown[]) => c[1])).toContain(
      BILLING_EVENTS.SUBSCRIPTION_CANCELED,
    );
  });

  it("REG-B398: when Stripe does not confirm, the cancel refuses with nothing written, never a local-only cancel", async () => {
    const { svc, tx, events, stripe } = make("sub_acme_1");
    stripe.updateSubscription.mockRejectedValue(new Error("boom"));

    await expect(svc.cancel("t-acme", "u-1")).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(tx.tenantSubscription.update).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("REG-B398: a row with no Stripe subscription (manual billing) never calls Stripe", async () => {
    const { svc, tx, stripe } = make(null);
    await svc.cancel("t-acme", "u-1");
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(tx.tenantSubscription.update).toHaveBeenCalledTimes(1);
  });
});
