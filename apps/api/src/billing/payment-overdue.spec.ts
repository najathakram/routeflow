import { ConflictException } from "@nestjs/common";
import { assertNotPaymentOverdue } from "./payment-overdue";

const OPEN = {
  status: "open",
  amountPaid: 0,
  amountDue: 4900,
  paymentProcessing: false,
  nextPaymentAttempt: null,
  attemptCount: 3,
  subscriptionId: "sub_1",
  amountRemaining: 4900,
  hostedInvoiceUrl: "https://pay.example.test/i/in_1",
};

function make(opts: {
  marker?: string | null;
  tenantStatus?: string;
  facts?: any;
  stripeThrows?: boolean;
}) {
  const prisma: any = {
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue({ pastDueInvoiceId: opts.marker ?? null }),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ status: opts.tenantStatus ?? "READ_ONLY" }),
    },
  };
  const stripe: any = {
    getInvoiceFacts: opts.stripeThrows
      ? jest.fn().mockRejectedValue(new Error("stripe down"))
      : jest.fn().mockResolvedValue(opts.facts ?? OPEN),
  };
  return { prisma, stripe };
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    return (e as ConflictException).getResponse() as any;
  }
}

describe("assertNotPaymentOverdue - 409 PAYMENT_OVERDUE (SA-733r M1, r3 N1)", () => {
  it("no owed marker: nothing is read from Stripe and nothing is refused", async () => {
    const d = make({ marker: null });
    expect(await refusal(assertNotPaymentOverdue(d, "t1"))).toBeNull();
    expect(d.stripe.getInvoiceFacts).not.toHaveBeenCalled();
  });

  it("marker set + invoice still open: 409 PAYMENT_OVERDUE carrying hosted_invoice_url", async () => {
    const d = make({ marker: "in_1" });
    const body = await refusal(assertNotPaymentOverdue(d, "t1"));
    expect(body).toMatchObject({
      code: "PAYMENT_OVERDUE",
      hosted_invoice_url: "https://pay.example.test/i/in_1",
    });
    expect(d.stripe.getInvoiceFacts).toHaveBeenCalledWith("in_1");
  });

  it("the check is the marker + Stripe, never the reason text: a cancelled-while-paused tenant is still refused", async () => {
    const d = make({ marker: "in_1", tenantStatus: "READ_ONLY" });
    expect((await refusal(assertNotPaymentOverdue(d, "t1")))?.code).toBe("PAYMENT_OVERDUE");
  });

  it("an uncollectible invoice is still owed", async () => {
    const d = make({ marker: "in_1", facts: { ...OPEN, status: "uncollectible" } });
    expect((await refusal(assertNotPaymentOverdue(d, "t1")))?.code).toBe("PAYMENT_OVERDUE");
  });

  it("an invoice Stripe now shows paid / void (or nothing left) is not owed: no refusal", async () => {
    for (const facts of [
      { ...OPEN, status: "paid", amountPaid: 4900, amountRemaining: 0 },
      { ...OPEN, status: "void" },
      { ...OPEN, amountRemaining: 0 },
      { ...OPEN, status: null },
    ]) {
      expect(
        await refusal(assertNotPaymentOverdue(make({ marker: "in_1", facts }), "t1")),
      ).toBeNull();
    }
  });

  it("fails CLOSED: an unreadable Stripe is a retryable 409 PAYMENT_STATE_UNKNOWN, never go-ahead", async () => {
    const d = make({ marker: "in_1", stripeThrows: true });
    expect((await refusal(assertNotPaymentOverdue(d, "t1")))?.code).toBe("PAYMENT_STATE_UNKNOWN");
  });

  it("dark: an ACTIVE tenant with a failing payment is not blocked (and Stripe is not even asked)", async () => {
    const d = make({ marker: "in_1", tenantStatus: "ACTIVE" });
    expect(await refusal(assertNotPaymentOverdue({ ...d, mode: "dark" }, "t1"))).toBeNull();
    expect(d.stripe.getInvoiceFacts).not.toHaveBeenCalled();
  });

  it("enforced: an ACTIVE tenant with an owed invoice is refused too", async () => {
    const d = make({ marker: "in_1", tenantStatus: "ACTIVE" });
    expect((await refusal(assertNotPaymentOverdue({ ...d, mode: "enforced" }, "t1")))?.code).toBe(
      "PAYMENT_OVERDUE",
    );
  });

  it("dark still refuses a READ_ONLY tenant (the marker is the debt)", async () => {
    const d = make({ marker: "in_1", tenantStatus: "READ_ONLY" });
    expect((await refusal(assertNotPaymentOverdue({ ...d, mode: "dark" }, "t1")))?.code).toBe(
      "PAYMENT_OVERDUE",
    );
  });
});
