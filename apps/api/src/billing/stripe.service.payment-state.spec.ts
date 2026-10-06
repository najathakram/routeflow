import { StripeService } from "./stripe.service";

// B1158: the subscription's PAYMENT state under API 2026-08-26.dahlia. `Invoice.payment_intent` no longer
// exists there: an invoice carries `payments` (InvoicePayment list) and each entry names its PaymentIntent at
// `payment.payment_intent` (an id, or an object when expanded further). The fixture pins that SHAPE.
describe("B1158 StripeService.getSubscriptionPaymentState (dahlia shape)", () => {
  const sub = (status: string, payments: unknown[] | null) => ({
    id: "sub_old",
    object: "subscription",
    status,
    latest_invoice:
      payments === null
        ? "in_1" // not expanded: a bare id
        : {
            id: "in_1",
            object: "invoice",
            status: "open",
            payments: { object: "list", data: payments, has_more: false },
          },
  });
  const piPayment = (pi: unknown, status = "open") => ({
    id: "inpay_1",
    object: "invoice_payment",
    status,
    payment: { type: "payment_intent", payment_intent: pi },
  });

  function make(subscription: unknown | Error, intents: Record<string, string> = {}) {
    const subRetrieve = jest.fn(async () => {
      if (subscription instanceof Error) throw subscription;
      return subscription;
    });
    const piRetrieve = jest.fn(async (id: string) => {
      if (!(id in intents))
        throw Object.assign(new Error("No such pi"), { code: "resource_missing" });
      return { id, object: "payment_intent", status: intents[id] };
    });
    const svc = new StripeService({ get: () => undefined } as never);
    (svc as any).stripe = {
      subscriptions: { retrieve: subRetrieve },
      paymentIntents: { retrieve: piRetrieve },
    };
    return { svc, subRetrieve, piRetrieve };
  }

  it("expands latest_invoice.payments and reads the PaymentIntent by id: processing -> true", async () => {
    const { svc, subRetrieve, piRetrieve } = make(sub("incomplete", [piPayment("pi_1")]), {
      pi_1: "processing",
    });
    await expect(svc.getSubscriptionPaymentState("sub_old")).resolves.toEqual({
      status: "incomplete",
      paymentProcessing: true,
    });
    expect(subRetrieve).toHaveBeenCalledWith("sub_old", { expand: ["latest_invoice.payments"] });
    expect(piRetrieve).toHaveBeenCalledWith("pi_1");
  });

  it("requires_payment_method / canceled / succeeded are not processing", async () => {
    for (const st of ["requires_payment_method", "canceled", "succeeded"]) {
      const { svc } = make(sub("incomplete", [piPayment("pi_1")]), { pi_1: st });
      await expect(svc.getSubscriptionPaymentState("sub_old")).resolves.toEqual({
        status: "incomplete",
        paymentProcessing: false,
      });
    }
  });

  it("any of several payments processing counts; non-PaymentIntent payments (out_of_band) are skipped", async () => {
    const { svc, piRetrieve } = make(
      sub("incomplete", [
        { id: "inpay_0", payment: { type: "out_of_band_payment", out_of_band_payment: {} } },
        piPayment("pi_a"),
        piPayment("pi_b"),
      ]),
      { pi_a: "requires_payment_method", pi_b: "processing" },
    );
    await expect(svc.getSubscriptionPaymentState("sub_old")).resolves.toMatchObject({
      paymentProcessing: true,
    });
    expect(piRetrieve).toHaveBeenCalledTimes(2);
  });

  it("an already-expanded PaymentIntent object is used without another retrieve", async () => {
    const { svc, piRetrieve } = make(
      sub("incomplete", [piPayment({ id: "pi_1", status: "processing" })]),
    );
    await expect(svc.getSubscriptionPaymentState("sub_old")).resolves.toMatchObject({
      paymentProcessing: true,
    });
    expect(piRetrieve).not.toHaveBeenCalled();
  });

  it("no invoice / an unexpanded invoice / no payments: status only, not processing", async () => {
    for (const s of [sub("paused", null), sub("paused", []), { id: "s", status: "paused" }]) {
      const { svc } = make(s);
      await expect(svc.getSubscriptionPaymentState("sub_old")).resolves.toEqual({
        status: "paused",
        paymentProcessing: false,
      });
    }
  });

  it("resource_missing on the subscription -> { status: null, paymentProcessing: false }", async () => {
    const { svc } = make(
      Object.assign(new Error("No such subscription"), { code: "resource_missing" }),
    );
    await expect(svc.getSubscriptionPaymentState("sub_old")).resolves.toEqual({
      status: null,
      paymentProcessing: false,
    });
  });

  it("any other error rethrows (a timeout says nothing about the subscription)", async () => {
    const { svc } = make(Object.assign(new Error("boom"), { type: "StripeConnectionError" }));
    await expect(svc.getSubscriptionPaymentState("sub_old")).rejects.toThrow("boom");
  });

  it("a PaymentIntent read that errors rethrows too (never reads as 'not processing')", async () => {
    const { svc } = make(sub("incomplete", [piPayment("pi_missing")]), {});
    await expect(svc.getSubscriptionPaymentState("sub_old")).rejects.toThrow("No such pi");
  });
});

describe("B1158 StripeService.getCheckoutSession", () => {
  it("retrieves the session by id", async () => {
    const retrieve = jest.fn(async (id: string) => ({ id }));
    const svc = new StripeService({ get: () => undefined } as never);
    (svc as any).stripe = { checkout: { sessions: { retrieve } } };
    await expect(svc.getCheckoutSession("cs_1")).resolves.toEqual({ id: "cs_1" });
    expect(retrieve).toHaveBeenCalledWith("cs_1");
  });
});
