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

  it("checkout.session.expired -> onSessionExpired; invoice.paid -> onInvoicePaid", async () => {
    const { billing, catchup } = make();
    await billing.handleWebhookEvent(ev("checkout.session.expired", { id: "cs_1" }));
    await billing.handleWebhookEvent(ev("invoice.paid", { id: "in_1" }));
    expect(catchup.onSessionExpired).toHaveBeenCalledWith({ id: "cs_1" });
    expect(catchup.onInvoicePaid).toHaveBeenCalledWith({ id: "in_1" });
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
