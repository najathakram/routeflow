import { StripeService } from "./stripe.service";

// SA-733r4 N2: the invoice facts the catch-up claim is judged from, under API 2026-08-26.dahlia - the invoice
// has no `payment_intent`; a payment still `processing` (ACH) lives on `payments.data[].payment.payment_intent`,
// and the subscription is at `parent.subscription_details.subscription`.
describe("StripeService.getInvoiceFacts (dahlia shape)", () => {
  const invoice = (over: Record<string, unknown> = {}) => ({
    id: "in_1",
    object: "invoice",
    status: "open",
    amount_paid: 0,
    amount_due: 14900,
    attempt_count: 2,
    next_payment_attempt: null,
    parent: { subscription_details: { subscription: "sub_1" } },
    payments: { data: [] },
    ...over,
  });
  function make(inv: unknown | Error, intents: Record<string, string> = {}) {
    const retrieve = jest.fn(async () => {
      if (inv instanceof Error) throw inv;
      return inv;
    });
    const piRetrieve = jest.fn(async (id: string) => ({ id, status: intents[id] }));
    const svc = new StripeService({ get: () => undefined } as never);
    (svc as any).stripe = { invoices: { retrieve }, paymentIntents: { retrieve: piRetrieve } };
    return { svc, retrieve, piRetrieve };
  }

  it("expands the payments' PaymentIntent in the one retrieve and reads the dahlia subscription link", async () => {
    const { svc, retrieve } = make(invoice());
    const facts = await svc.getInvoiceFacts("in_1");
    expect(retrieve).toHaveBeenCalledWith("in_1", {
      expand: ["payments.data.payment.payment_intent"],
    });
    expect(facts).toEqual({
      status: "open",
      amountPaid: 0,
      amountDue: 14900,
      paymentProcessing: false,
      nextPaymentAttempt: null,
      attemptCount: 2,
      subscriptionId: "sub_1",
      // SA-733r7: the 409 PAYMENT_OVERDUE body carries the hosted pay page; amount_remaining is read when present
      hostedInvoiceUrl: null,
    });
  });

  it("reads amount_remaining and hosted_invoice_url when Stripe sends them (the PAYMENT_OVERDUE guard and its pay link)", async () => {
    const { svc } = make(
      invoice({ amount_remaining: 14900, hosted_invoice_url: "https://pay.example.test/i/in_1" }),
    );
    expect(await svc.getInvoiceFacts("in_1")).toMatchObject({
      amountRemaining: 14900,
      hostedInvoiceUrl: "https://pay.example.test/i/in_1",
    });
  });

  it("a PaymentIntent in `processing` (an ACH debit in flight) => paymentProcessing", async () => {
    const pay = (pi: unknown) => ({ payment: { type: "payment_intent", payment_intent: pi } });
    const expanded = make(
      invoice({ payments: { data: [pay({ id: "pi_1", status: "processing" })] } }),
    );
    expect((await expanded.svc.getInvoiceFacts("in_1")).paymentProcessing).toBe(true);
    expect(expanded.piRetrieve).not.toHaveBeenCalled();
    const byId = make(invoice({ payments: { data: [pay("pi_2")] } }), { pi_2: "processing" });
    expect((await byId.svc.getInvoiceFacts("in_1")).paymentProcessing).toBe(true);
    expect(byId.piRetrieve).toHaveBeenCalledWith("pi_2");
  });

  it("resource_missing => status null; any other error rethrows (a failed read says nothing about money in flight)", async () => {
    const gone = make(Object.assign(new Error("No such invoice"), { code: "resource_missing" }));
    expect((await gone.svc.getInvoiceFacts("in_x")).status).toBeNull();
    const down = make(new Error("stripe 503"));
    await expect(down.svc.getInvoiceFacts("in_1")).rejects.toThrow("stripe 503");
  });

  it("a scheduled retry is carried through", async () => {
    const { svc } = make(invoice({ next_payment_attempt: 1791172800 }));
    expect((await svc.getInvoiceFacts("in_1")).nextPaymentAttempt).toBe(1791172800);
  });
});

describe("StripeService.listInvoiceItems", () => {
  it("lists one invoice's items (the catch-up stub is found by its metadata tag)", async () => {
    const list = jest.fn(async () => ({
      data: [{ id: "ii_1", metadata: { catchup_for: "cs_1" } }],
    }));
    const svc = new StripeService({ get: () => undefined } as never);
    (svc as any).stripe = { invoiceItems: { list } };
    const items = await svc.listInvoiceItems("in_1");
    expect(list).toHaveBeenCalledWith({ invoice: "in_1", limit: 100 });
    expect(items[0].metadata.catchup_for).toBe("cs_1");
  });
});
