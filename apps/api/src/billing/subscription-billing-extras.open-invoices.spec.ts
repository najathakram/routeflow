import {
  pickStateFacts,
  SubscriptionBillingExtras,
  trimBillingViewForRole,
} from "./subscription-billing-extras";

/**
 * SA-777: the Billing card's facts: `outstandingTotal` (Σ amount_remaining over the OPEN Stripe invoices, integer
 * cents -> dollars server-side), `billingState` (one pure derivation), `payNowUrl` (the OLDEST owed invoice's hosted
 * page, omitted while a payment is processing), the customer id from the tenant row only, and every one of them
 * OMITTED (not zeroed) when Stripe cannot answer.
 */
const SUB: any = {
  pastDueInvoiceId: null,
  stripeCustomerId: "cus_tenant_row",
  stripeSubId: "sub_1",
  periodEnd: null,
};
const DAY = 86_400;
const nowSec = () => Math.floor(Date.now() / 1000);
const row = (over: Record<string, unknown> = {}) => ({
  id: "in_1",
  amount_remaining: 14900,
  attempt_count: 0,
  due_date: null,
  created: nowSec() - DAY,
  hosted_invoice_url: "https://pay.example/in_1",
  ...over,
});

function make(
  over: {
    rows?: any[];
    listError?: boolean;
    hasMore?: boolean;
    processing?: Record<string, boolean>;
  } = {},
) {
  const prisma = {
    getTenantId: () => null,
    tenantConfig: { findUnique: jest.fn().mockResolvedValue({ timezone: "America/Chicago" }) },
    user: { findMany: jest.fn().mockResolvedValue([{ email: "dana@example.test" }]) },
  } as any;
  const stripe = {
    isConfigured: true,
    listOpenCustomerInvoices: over.listError
      ? jest.fn().mockRejectedValue(new Error("stripe down"))
      : jest.fn().mockResolvedValue({ rows: over.rows ?? [row()], hasMore: over.hasMore ?? false }),
    getInvoiceFacts: jest.fn().mockImplementation(async (id: string) => ({
      status: "open",
      amountDue: 0,
      amountPaid: 0,
      paymentProcessing: over.processing?.[id] ?? false,
      attemptCount: 0,
    })),
    getDefaultCardSummary: jest.fn().mockResolvedValue(null),
    previewNextInvoice: jest.fn().mockResolvedValue(null),
  } as any;
  return { extras: new SubscriptionBillingExtras(prisma, stripe), prisma, stripe };
}

describe("SubscriptionBillingExtras.read: open-invoice facts (SA-777)", () => {
  it("outstandingTotal sums integer cents across the open invoices and converts once", async () => {
    const { extras } = make({
      rows: [
        row({ id: "a", amount_remaining: 10, created: 100 }),
        row({ id: "b", amount_remaining: 20, created: 200 }),
        row({ id: "c", amount_remaining: 4999, created: 300 }),
      ],
    });
    const out = await extras.read("t1", SUB);
    expect(out.outstandingTotal).toBe(50.29); // 5029 cents, exact (0.1 + 0.2 style float sums are not used)
  });

  it("no open invoice: current, total 0, no pay link (a real answer, not an omission)", async () => {
    const { extras } = make({ rows: [] });
    const out = await extras.read("t1", SUB);
    expect(out).toMatchObject({
      billingState: "current",
      outstandingTotal: 0,
      paymentProcessing: false,
    });
    expect(out.payNowUrl).toBeUndefined();
  });

  it("an unpaid, unattempted invoice is due; a failed attempt makes it overdue", async () => {
    const due = await make().extras.read("t1", SUB);
    expect(due.billingState).toBe("due");
    const overdue = await make({ rows: [row({ attempt_count: 2 })] }).extras.read("t1", SUB);
    expect(overdue.billingState).toBe("overdue");
  });

  it("payNowUrl is the OLDEST owed invoice's hosted page", async () => {
    const { extras } = make({
      rows: [
        row({ id: "new", created: 900, hosted_invoice_url: "https://pay.example/new" }),
        row({ id: "old", created: 100, hosted_invoice_url: "https://pay.example/old" }),
      ],
    });
    expect((await extras.read("t1", SUB)).payNowUrl).toBe("https://pay.example/old");
  });

  it("a payment still processing: state processing, paymentProcessing true, NO pay link", async () => {
    const { extras } = make({ processing: { in_1: true } });
    const out = await extras.read("t1", SUB);
    expect(out).toMatchObject({ billingState: "processing", paymentProcessing: true });
    expect(out.payNowUrl).toBeUndefined();
  });

  it("the customer id is the tenant row's, and the list is capped at 10", async () => {
    const { extras, stripe } = make();
    await extras.read("t1", { ...SUB, stripeCustomerId: "cus_from_row" });
    expect(stripe.listOpenCustomerInvoices).toHaveBeenCalledWith(
      "cus_from_row",
      10,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("a Stripe failure OMITS every SA-777 field (never zero, never 'current') and is not cached", async () => {
    const { extras, stripe } = make({ listError: true });
    const out = await extras.read("t1", SUB);
    for (const k of [
      "outstandingTotal",
      "billingState",
      "paymentProcessing",
      "openInvoiceDueLabel",
      "payNowUrl",
    ])
      expect(out).not.toHaveProperty(k);
    // recovered: the next read asks Stripe again (the failure was not remembered for the TTL)
    stripe.listOpenCustomerInvoices.mockResolvedValue({ rows: [row()], hasMore: false });
    expect((await extras.read("t1", SUB)).billingState).toBe("due");
  });

  it("the 10-invoice cap cut the list (has_more): the total would under-report, so every field is OMITTED", async () => {
    const { extras } = make({ hasMore: true });
    const out = await extras.read("t1", SUB);
    expect(out).not.toHaveProperty("outstandingTotal");
    expect(out).not.toHaveProperty("billingState");
    expect(out).not.toHaveProperty("payNowUrl");
  });

  it("an invoice in another currency is never printed as dollars: the fields are OMITTED", async () => {
    const { extras } = make({ rows: [row({ currency: "jpy" })] });
    expect(await extras.read("t1", SUB)).not.toHaveProperty("outstandingTotal");
    const usd = await make({ rows: [row({ currency: "usd" })] }).extras.read("t1", SUB);
    expect(usd.outstandingTotal).toBe(149);
  });

  it("a changed dunning marker bypasses the 60 s cache (a payment or a new failure reads fresh facts)", async () => {
    const { extras, stripe } = make();
    await extras.read("t1", { ...SUB, pastDueInvoiceId: null });
    await extras.read("t1", { ...SUB, pastDueInvoiceId: "in_1" });
    expect(stripe.listOpenCustomerInvoices).toHaveBeenCalledTimes(2);
  });

  it("one invoice settling and one unpaid: state overdue/due, Pay targets the unpaid one and its own amount", async () => {
    const { extras } = make({
      rows: [
        row({
          id: "settling",
          created: 100,
          amount_remaining: 14900,
          hosted_invoice_url: "https://pay.example/settling",
        }),
        row({
          id: "unpaid",
          created: 200,
          amount_remaining: 5000,
          attempt_count: 1,
          hosted_invoice_url: "https://pay.example/unpaid",
        }),
      ],
      processing: { settling: true },
    });
    const out = await extras.read("t1", SUB);
    expect(out).toMatchObject({
      billingState: "overdue",
      paymentProcessing: false,
      outstandingTotal: 199,
      payNowUrl: "https://pay.example/unpaid",
      payNowAmount: 50,
    });
  });

  it("payNowAmount is the oldest invoice's own amount, not the total (the button must collect what it says)", async () => {
    const { extras } = make({
      rows: [
        row({ id: "old", created: 100, amount_remaining: 14900 }),
        row({ id: "new", created: 200, amount_remaining: 14900 }),
      ],
    });
    const out = await extras.read("t1", SUB);
    expect(out.outstandingTotal).toBe(298);
    expect(out.payNowAmount).toBe(149);
  });

  it("no Stripe customer on the tenant row: the fields are omitted and Stripe is not called", async () => {
    const { extras, stripe } = make();
    const out = await extras.read("t1", { ...SUB, stripeCustomerId: null });
    expect(out).not.toHaveProperty("billingState");
    expect(stripe.listOpenCustomerInvoices).not.toHaveBeenCalled();
  });

  it("a second read inside 60 s is served from the cache (one Stripe list)", async () => {
    const { extras, stripe } = make();
    await extras.read("t1", SUB);
    await extras.read("t1", SUB);
    expect(stripe.listOpenCustomerInvoices).toHaveBeenCalledTimes(1);
  });

  it("billingContactEmail is the oldest-active-admin pick (an internal address is skipped)", async () => {
    const out = await make().extras.read("t1", SUB);
    expect(out).toMatchObject({
      billingContactEmail: "dana@example.test",
    });
  });

  it("the due label is formatted in the tenant's zone (the browser never computes a date)", async () => {
    const { extras } = make({
      rows: [row({ created: Math.floor(new Date("2026-10-15T03:30:00Z").getTime() / 1000) })],
    });
    // 03:30Z on the 15th is still the 14th in Chicago
    expect((await extras.read("t1", SUB)).openInvoiceDueLabel).toBe("Oct 14");
  });
});

describe("trimBillingViewForRole (SA-777)", () => {
  const view: any = {
    billingState: "overdue",
    outstandingTotal: 149,
    payNowUrl: "https://pay.example/in_1",
    payNowAmount: 149,
    openInvoiceDueLabel: "Oct 1",
    billingContactEmail: "dana@example.test",
    openInvoiceAmount: 149,
  };

  it("an operator keeps the state, the date and who to ask - and loses the amount and the pay link", () => {
    const out: any = trimBillingViewForRole(view, "OPERATOR");
    expect(out).toMatchObject({
      billingState: "overdue",
      openInvoiceDueLabel: "Oct 1",
      billingContactEmail: "dana@example.test",
    });
    expect(out).not.toHaveProperty("outstandingTotal");
    expect(out).not.toHaveProperty("payNowUrl");
    expect(out).not.toHaveProperty("payNowAmount");
    expect(out.openInvoiceAmount).toBeNull();
  });

  it("a tenant admin sees everything", () => {
    expect(trimBillingViewForRole(view, "TENANT_ADMIN")).toEqual(view);
  });
});

describe("pickStateFacts (SA-777): the view carries only what Stripe answered", () => {
  it("an omitted field stays out of the JSON (never null, never 0)", () => {
    const out = pickStateFacts({ billingContactEmail: "a@example.test" });
    expect(Object.keys(out)).toEqual([]);
    expect(JSON.parse(JSON.stringify(out))).not.toHaveProperty("outstandingTotal");
  });

  it("a zero total and the 'current' state are real answers and are kept", () => {
    const out = pickStateFacts({
      outstandingTotal: 0,
      billingState: "current",
      paymentProcessing: false,
    });
    expect(out).toMatchObject({
      outstandingTotal: 0,
      billingState: "current",
      paymentProcessing: false,
    });
  });
});
