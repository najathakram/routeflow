import { SubscriptionBillingExtras } from "./subscription-billing-extras";

/**
 * SA-733r6 (B4): the extra facts the subscription view carries so the web banner can name the admin, print the
 * open invoice as money and show the autopay card. Stripe is read through the existing StripeService; a failed
 * read yields null (the banner then simply has less to say), never a thrown view.
 */

const SUB: any = {
  pastDueSince: new Date("2026-11-01T14:00:00Z"),
  pastDueInvoiceId: "in_1",
  stripeCustomerId: "cus_1",
  // The REAL column name (platform.prisma: `stripeSubId`), alongside the other columns a real row carries.
  stripeSubId: "sub_1",
  cancelAtPeriodEnd: false,
  failedPaymentCount: 1,
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
    zone?: string | null;
  } = {},
) {
  const prisma = {
    getTenantId: () => null,
    tenantConfig: {
      findUnique: jest.fn().mockResolvedValue({ timezone: over.zone ?? null }),
    },
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
    expect(out.nextCharge).toEqual({
      amount: 149,
      date: "2026-12-01T00:00:00.000Z",
      dateLabel: "Dec 1",
    });
  });

  it("S1: nextCharge renders for a real-shaped row (the column is stripeSubId, not stripeSubscriptionId)", async () => {
    const { extras, stripe } = make();
    const out = await extras.read("t1", { ...SUB, pastDueInvoiceId: null, pastDueSince: null });
    expect(stripe.previewNextInvoice).toHaveBeenCalledWith("sub_1");
    expect(out.nextCharge?.amount).toBe(149);
  });

  it("a tenant with no Stripe customer has no card and no next charge, and Stripe is not asked", async () => {
    const { extras, stripe } = make();
    const out = await extras.read("t1", {
      ...SUB,
      stripeCustomerId: null,
      stripeSubId: null,
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

describe("SubscriptionBillingExtras labels (S4: the TENANT zone, never the browser)", () => {
  // Nov 1 2026 03:00Z is Oct 31 22:00 in Chicago (CDT) but Nov 1 in UTC: the month the invoice is "for" differs.
  const edge = { ...SUB, pastDueSince: new Date("2026-11-01T03:00:00Z") };

  it("America/Chicago: the failed charge was Oct 31 local, so the month is October and grace ends Nov 7", async () => {
    const { extras } = make({ zone: "America/Chicago" });
    const out = await extras.read("t1", edge);
    expect(out.pastDueMonthLabel).toBe("October");
    expect(out.graceEndsLabel).toBe("Nov 7");
  });

  it("no zone configured: falls back to UTC (Nov 1 -> November, Nov 8)", async () => {
    const { extras } = make({ zone: null });
    const out = await extras.read("t1", edge);
    expect(out.pastDueMonthLabel).toBe("November");
    expect(out.graceEndsLabel).toBe("Nov 8");
  });

  it("the next-charge date label is the renewal date in the tenant zone", async () => {
    const { extras } = make({ zone: "America/Chicago" });
    const out = await extras.read("t1", {
      ...SUB,
      pastDueInvoiceId: null,
      pastDueSince: null,
      periodEnd: new Date("2026-12-01T03:00:00Z"),
    });
    expect(out.nextCharge?.dateLabel).toBe("Nov 30");
  });

  it("nothing owed: no month or deadline labels", async () => {
    const { extras } = make();
    const out = await extras.read("t1", { ...SUB, pastDueInvoiceId: null, pastDueSince: null });
    expect(out.pastDueMonthLabel).toBeNull();
    expect(out.graceEndsLabel).toBeNull();
  });
});

describe("SubscriptionBillingExtras.hostedInvoiceUrl owed check (S2)", () => {
  const url = "https://x.example/i";
  const paid = { status: "paid", amountDue: 14900, amountPaid: 14900, hostedInvoiceUrl: url };
  const zero = {
    status: "open",
    amountDue: 0,
    amountPaid: 0,
    amountRemaining: 0,
    hostedInvoiceUrl: url,
  };

  it("is null for an invoice that is no longer owed (paid, void, or nothing remaining)", async () => {
    expect(await make({ facts: paid }).extras.hostedInvoiceUrl("in_1")).toBeNull();
    expect(
      await make({ facts: { ...paid, status: "void" } }).extras.hostedInvoiceUrl("in_1"),
    ).toBeNull();
    expect(await make({ facts: zero }).extras.hostedInvoiceUrl("in_1")).toBeNull();
  });

  it("an uncollectible write-off is not owed either (B3's single predicate)", async () => {
    const { extras } = make({
      facts: { status: "uncollectible", amountDue: 100, amountPaid: 0, hostedInvoiceUrl: url },
    });
    expect(await extras.hostedInvoiceUrl("in_1")).toBeNull();
  });

  it("a Stripe call that hangs is cut off (no unbounded wait on the portal route)", async () => {
    jest.useFakeTimers();
    try {
      const { extras, stripe } = make();
      stripe.getInvoiceFacts = jest.fn(() => new Promise(() => undefined));
      const pending = extras.hostedInvoiceUrl("in_1");
      await jest.advanceTimersByTimeAsync(60_000);
      expect(await pending).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
