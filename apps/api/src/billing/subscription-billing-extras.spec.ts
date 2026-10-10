import { SubscriptionBillingExtras } from "./subscription-billing-extras";

/**
 * SA-733r6 (B4): the extra facts the subscription view carries so the web banner can name the admin, print the
 * open invoice as money and show the autopay card. Stripe is read through the existing StripeService; a failed
 * read yields null (the banner then simply has less to say), never a thrown view.
 */

const SUB = {
  pastDueSince: new Date("2026-11-01T14:00:00Z"),
  pastDueInvoiceId: "in_1",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
  periodEnd: new Date("2026-12-01T00:00:00Z"),
};

function make(
  over: {
    admin?: { username: string } | null;
    facts?: any;
    factsError?: boolean;
    card?: any;
    cardError?: boolean;
    preview?: any;
    configured?: boolean;
  } = {},
) {
  const prisma = {
    user: {
      findFirst: jest
        .fn()
        .mockResolvedValue(over.admin === undefined ? { username: "Dana" } : over.admin),
    },
  } as any;
  const stripe = {
    isConfigured: over.configured ?? true,
    getInvoiceFacts: over.factsError
      ? jest.fn().mockRejectedValue(new Error("stripe down"))
      : jest.fn().mockResolvedValue(
          over.facts ?? {
            status: "open",
            amountDue: 14900,
            amountPaid: 0,
            amountRemaining: 14900,
          },
        ),
    getDefaultCardSummary: over.cardError
      ? jest.fn().mockRejectedValue(new Error("stripe down"))
      : jest
          .fn()
          .mockResolvedValue(
            over.card === undefined
              ? { brand: "visa", last4: "4242", expMonth: 10, expYear: 2026 }
              : over.card,
          ),
    previewNextInvoice: jest
      .fn()
      .mockResolvedValue(over.preview === undefined ? { amount_due: 14900 } : over.preview),
  } as any;
  return { extras: new SubscriptionBillingExtras(prisma, stripe), prisma, stripe };
}

describe("SubscriptionBillingExtras.read (B4 view fields)", () => {
  it("billingContactName is the OLDEST ACTIVE TENANT_ADMIN's name (a fixed, stated rule)", async () => {
    const { extras, prisma } = make();
    const out = await extras.read("t1", SUB);
    expect(out.billingContactName).toBe("Dana");
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: "t1",
          role: "TENANT_ADMIN",
          status: "ACTIVE",
          deletedAt: null,
        }),
        orderBy: { createdAt: "asc" },
      }),
    );
  });

  it("billingContactName is null when the tenant has no active admin", async () => {
    const { extras } = make({ admin: null });
    expect((await extras.read("t1", SUB)).billingContactName).toBeNull();
  });

  it("openInvoiceAmount is the pastDueInvoiceId invoice's amount_remaining, in dollars (never a dash)", async () => {
    const { extras, stripe } = make();
    const out = await extras.read("t1", SUB);
    expect(out.openInvoiceAmount).toBe(149);
    expect(stripe.getInvoiceFacts).toHaveBeenCalledWith("in_1");
  });

  it("openInvoiceAmount falls back to amount_due minus amount_paid when amount_remaining is absent", async () => {
    const { extras } = make({ facts: { status: "open", amountDue: 14900, amountPaid: 4900 } });
    expect((await extras.read("t1", SUB)).openInvoiceAmount).toBe(100);
  });

  it("openInvoiceAmount is null with no pastDueInvoiceId, and Stripe is not asked", async () => {
    const { extras, stripe } = make();
    const out = await extras.read("t1", { ...SUB, pastDueInvoiceId: null, pastDueSince: null });
    expect(out.openInvoiceAmount).toBeNull();
    expect(stripe.getInvoiceFacts).not.toHaveBeenCalled();
  });

  it("openInvoiceAmount is null when the invoice is no longer owed (paid / void)", async () => {
    const { extras } = make({ facts: { status: "paid", amountDue: 14900, amountPaid: 14900 } });
    expect((await extras.read("t1", SUB)).openInvoiceAmount).toBeNull();
  });

  it("a Stripe failure degrades to nulls instead of failing the view", async () => {
    const { extras } = make({ factsError: true, cardError: true });
    const out = await extras.read("t1", SUB);
    expect(out.openInvoiceAmount).toBeNull();
    expect(out.paymentMethodSummary).toBeNull();
    expect(out.billingContactName).toBe("Dana");
  });

  it("paymentMethodSummary carries brand / last4 / expiry and nextCharge the amount and the renewal date", async () => {
    const { extras } = make();
    const out = await extras.read("t1", { ...SUB, pastDueInvoiceId: null, pastDueSince: null });
    expect(out.paymentMethodSummary).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: 10,
      expYear: 2026,
    });
    expect(out.nextCharge).toEqual({ amount: 149, date: "2026-12-01T00:00:00.000Z" });
  });

  it("a tenant with no Stripe customer has no card and no next charge, and Stripe is not asked", async () => {
    const { extras, stripe } = make();
    const out = await extras.read("t1", {
      ...SUB,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    expect(out.paymentMethodSummary).toBeNull();
    expect(out.nextCharge).toBeNull();
    expect(stripe.getDefaultCardSummary).not.toHaveBeenCalled();
  });

  it("Stripe not configured: every Stripe-backed field is null, contact name still resolves", async () => {
    const { extras, stripe } = make({ configured: false });
    const out = await extras.read("t1", SUB);
    expect(out.openInvoiceAmount).toBeNull();
    expect(out.paymentMethodSummary).toBeNull();
    expect(stripe.getInvoiceFacts).not.toHaveBeenCalled();
    expect(out.billingContactName).toBe("Dana");
  });

  it("caches the Stripe reads per tenant so a 60 s poll does not hit Stripe each time", async () => {
    const { extras, stripe } = make();
    await extras.read("t1", SUB);
    await extras.read("t1", SUB);
    expect(stripe.getInvoiceFacts).toHaveBeenCalledTimes(1);
    expect(stripe.getDefaultCardSummary).toHaveBeenCalledTimes(1);
  });
});

describe("SubscriptionBillingExtras.hostedInvoiceUrl (the admin's Pay link)", () => {
  it("returns Stripe's hosted invoice URL for the open invoice", async () => {
    const { extras } = make({
      facts: {
        status: "open",
        amountDue: 14900,
        amountPaid: 0,
        hostedInvoiceUrl: "https://invoice.example/i/1",
      },
    });
    expect(await extras.hostedInvoiceUrl("in_1")).toBe("https://invoice.example/i/1");
  });

  it("is null when Stripe fails or the invoice has no hosted page", async () => {
    expect(await make({ factsError: true }).extras.hostedInvoiceUrl("in_1")).toBeNull();
    expect(await make().extras.hostedInvoiceUrl("in_1")).toBeNull();
  });
});
