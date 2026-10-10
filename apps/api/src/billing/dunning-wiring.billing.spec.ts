import { ConflictException } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { DunningService } from "./dunning.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

// The coupon sync / reset have their own specs; here they are inert so a webhook reaches the dunning hooks.
jest.mock("./coupon-state", () => ({
  applyCouponStateTx: jest.fn().mockResolvedValue(undefined),
  resetCouponState: jest.fn().mockResolvedValue(undefined),
  syncCouponFromStripe: jest.fn().mockResolvedValue({}),
}));

/**
 * SA-733r7 PR-B3 wiring: BillingService routes invoice.paid / invoice.payment_failed to dunning, drops B410's
 * direct email, books the pause (-MRR once) and the resume (+MRR once, only via invoice.paid) through its one
 * transitionAndEmit, and never lets payment_succeeded reinstate a paused or cancelled tenant.
 */

const LIVE_SUB = {
  tenantId: "t1",
  planKey: "BUSINESS",
  basePriceSnapshot: 349,
  discount: 0,
  couponFull: false,
  stripeSubId: "sub_1",
  stripeCustomerId: "cus_1",
  failedPaymentCount: 0,
  cancelAtPeriodEnd: false,
  tenant: { id: "t1", slug: "acme", name: "Acme", status: "ACTIVE", readOnlyReason: null },
};

const OPEN_FACTS = {
  status: "open",
  amountPaid: 0,
  amountDue: 4900,
  amountRemaining: 4900,
  paymentProcessing: false,
  nextPaymentAttempt: null,
  attemptCount: 3,
  subscriptionId: "sub_1",
  hostedInvoiceUrl: "https://pay.example.test/i/in_1",
};

const invoiceEvent = (type: string, o: Record<string, unknown> = {}) => ({
  id: "evt_1",
  type,
  data: {
    object: {
      id: "in_1",
      customer: "cus_1",
      parent: { subscription_details: { subscription: "sub_1" } },
      ...o,
    },
  },
});

function make(
  o: {
    sub?: any;
    transitionCount?: number;
    addons?: any[];
    dunning?: any;
    realDunning?: boolean;
    sweepRows?: any[];
    logged?: any[];
  } = {},
) {
  const sub = o.sub ?? LIVE_SUB;
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ status: "ACTIVE" }),
      updateMany: jest.fn().mockResolvedValue({ count: o.transitionCount ?? 1 }),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ deletedAt: null, class: "PRODUCTION" }),
    },
    tenantAddon: { findMany: jest.fn().mockResolvedValue(o.addons ?? []) },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(sub),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma: any = {
    getTenantId: () => null,
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: "t1", slug: "acme", status: "ACTIVE" }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
    tenantSubscription: {
      findFirst: jest.fn().mockResolvedValue(sub),
      findMany: jest.fn().mockResolvedValue(o.sweepRows ?? []),
      findUnique: jest.fn().mockResolvedValue({ ...sub, pausedAt: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    tenantConfig: { findUnique: jest.fn().mockResolvedValue({ timezone: "UTC" }) },
    billingNotificationLog: { findMany: jest.fn().mockResolvedValue(o.logged ?? []) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const stripe: any = {
    isConfigured: true,
    getSubscription: jest.fn().mockResolvedValue({
      customer: "cus_1",
      status: "active",
      items: {
        data: [
          { id: "si", current_period_start: 1_700_000_000, current_period_end: 1_702_000_000 },
        ],
      },
    }),
    getInvoiceFacts: jest.fn().mockResolvedValue(OPEN_FACTS),
    listOpenSubscriptionInvoices: jest.fn().mockResolvedValue([]),
    updateSubscription: jest.fn().mockResolvedValue({}),
    createBillingPortalSession: jest.fn().mockResolvedValue({ url: "https://billing.test/p" }),
    createCheckoutSession: jest.fn(),
  };
  const email = { send: jest.fn().mockResolvedValue({}) };
  const tenantStatus = { invalidate: jest.fn() };
  const events = { emit: jest.fn().mockResolvedValue({}) };
  const billingNotification: any = {
    notifyCancelled: jest.fn().mockResolvedValue(undefined),
    notifySuspended: jest.fn().mockResolvedValue(undefined),
    notifyDunning: jest.fn().mockResolvedValue({ status: "sent", recipients: 1 }),
    recordDunningMilestone: jest.fn().mockResolvedValue(true),
    localDateLabel: jest.fn().mockResolvedValue("Nov 9, 2026"),
  };
  const dunning: any = o.realDunning
    ? new DunningService(prisma, stripe, billingNotification, tenantStatus as any)
    : (o.dunning ?? {
        bindTransition: jest.fn(),
        onInvoicePaid: jest.fn().mockResolvedValue("unchanged"),
        onPaymentFailed: jest.fn().mockResolvedValue("stamped"),
        clearPauseAfterCommit: jest.fn().mockResolvedValue(undefined),
        markCancelledWhilePaused: jest.fn().mockResolvedValue(false),
      });
  const svc = new BillingService(
    prisma,
    stripe,
    email as any,
    tenantStatus as any,
    events as any,
    {} as any,
    billingNotification,
    {} as any,
    {} as any,
    undefined,
    undefined,
    dunning,
  );
  return { svc, prisma, tx, stripe, email, events, tenantStatus, dunning, billingNotification };
}

const eventsOfType = (events: any, type: string) =>
  events.emit.mock.calls.filter((c: any[]) => c[1] === type);

describe("BillingService x dunning wiring (SA-733r7 PR-B3)", () => {
  const saved = process.env.BILLING_PAUSE_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = saved;
  });

  it("binds its transitionAndEmit into dunning at construction (MRR has one writer)", () => {
    const { dunning, svc } = make();
    expect(dunning.bindTransition).toHaveBeenCalledTimes(1);
    expect(typeof dunning.bindTransition.mock.calls[0][0]).toBe("function");
    expect(svc).toBeDefined();
  });

  describe("webhook routing", () => {
    it("invoice.paid reaches DunningService.onInvoicePaid with the invoice", async () => {
      const { svc, dunning } = make();
      await svc.handleWebhookEvent(invoiceEvent("invoice.paid"));
      expect(dunning.onInvoicePaid).toHaveBeenCalledWith(expect.objectContaining({ id: "in_1" }));
    });

    it("a throwing onInvoicePaid fails the webhook so Stripe redelivers (r4 F4 #6)", async () => {
      const { svc, dunning } = make();
      dunning.onInvoicePaid.mockRejectedValue(new Error("stripe down"));
      await expect(svc.handleWebhookEvent(invoiceEvent("invoice.paid"))).rejects.toThrow(
        "stripe down",
      );
    });

    it("invoice.payment_failed stamps BEFORE the failed-payment count moves, and sends no direct email (B410)", async () => {
      const { svc, dunning, prisma, email, stripe } = make();
      await svc.handleWebhookEvent(invoiceEvent("invoice.payment_failed"));
      expect(dunning.onPaymentFailed).toHaveBeenCalledWith(expect.objectContaining({ id: "in_1" }));
      expect(prisma.tenantSubscription.update).toHaveBeenCalledWith({
        where: { tenantId: "t1" },
        data: { failedPaymentCount: { increment: 1 } },
      });
      expect(dunning.onPaymentFailed.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.tenantSubscription.update.mock.invocationCallOrder[0],
      );
      expect(email.send).not.toHaveBeenCalled();
      expect(stripe.createBillingPortalSession).not.toHaveBeenCalled();
    });

    it("a throwing stamp aborts before the count moves, so the redelivery runs the handler once", async () => {
      const { svc, dunning, prisma } = make();
      dunning.onPaymentFailed.mockRejectedValue(new Error("stripe down"));
      await expect(
        svc.handleWebhookEvent(invoiceEvent("invoice.payment_failed")),
      ).rejects.toThrow();
      expect(prisma.tenantSubscription.update).not.toHaveBeenCalled();
    });
  });

  describe("transitionAndEmit - the MRR writer the pause and the resume ride", () => {
    const addons = [{ priceSnapshot: 12, quantity: 2 }];

    it("pause: ACTIVE -> READ_ONLY with readOnlyReason in the same CAS, -(349 + 24) booked once", async () => {
      const { svc, tx, events } = make({ addons });
      const ok = await svc.transitionAndEmit(
        "t1",
        { status: "ACTIVE" },
        "READ_ONLY",
        -1,
        BILLING_EVENTS.SUBSCRIPTION_SUSPENDED,
        { source: "dunning" },
        { data: { readOnlyReason: "payment_overdue" } },
      );
      expect(ok).toBe(true);
      expect(tx.tenant.updateMany).toHaveBeenCalledWith({
        where: { status: "ACTIVE", id: "t1" },
        data: { readOnlyReason: "payment_overdue", status: "READ_ONLY" },
      });
      const rows = eventsOfType(events, BILLING_EVENTS.SUBSCRIPTION_SUSPENDED);
      expect(rows).toHaveLength(1);
      expect(rows[0][3].amountDelta).toBe(-373);
    });

    it("a joined transaction runs inside the caller's tx and opens none of its own", async () => {
      const { svc, tx, prisma } = make({ addons });
      await svc.transitionAndEmit(
        "t1",
        { status: "ACTIVE" },
        "READ_ONLY",
        -1,
        BILLING_EVENTS.SUBSCRIPTION_SUSPENDED,
        {},
        { tx, data: { readOnlyReason: "payment_overdue" } },
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("a lost CAS books nothing", async () => {
      const { svc, events } = make({ transitionCount: 0 });
      expect(
        await svc.transitionAndEmit(
          "t1",
          { status: "ACTIVE" },
          "READ_ONLY",
          -1,
          BILLING_EVENTS.SUBSCRIPTION_SUSPENDED,
          {},
        ),
      ).toBe(false);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it("resume: back to ACTIVE nulls readOnlyReason, clears the clock + pause, books +(349 + 24) once", async () => {
      const { svc, tx, events } = make({ addons });
      await svc.transitionAndEmit(
        "t1",
        { status: "READ_ONLY", readOnlyReason: "payment_overdue" },
        "ACTIVE",
        1,
        BILLING_EVENTS.SUBSCRIPTION_RESUMED,
        {},
      );
      expect(tx.tenant.updateMany).toHaveBeenCalledWith({
        where: { status: "READ_ONLY", readOnlyReason: "payment_overdue", id: "t1" },
        data: { status: "ACTIVE", readOnlyReason: null },
      });
      expect(tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1" },
        data: { pastDueSince: null, pastDueInvoiceId: null, pausedAt: null },
      });
      const rows = eventsOfType(events, BILLING_EVENTS.SUBSCRIPTION_RESUMED);
      expect(rows).toHaveLength(1);
      expect(rows[0][3].amountDelta).toBe(373);
    });

    it("any other path back to ACTIVE (checkout, legacy reinstatement) also clears a pause on Stripe after commit", async () => {
      const exit = {
        tenantId: "t1",
        stripeSubId: "sub_1",
        exitAt: new Date("2026-11-09T12:00:00Z"),
      };
      const { svc, tx, dunning } = make();
      tx.tenantSubscription.findUnique.mockResolvedValue({
        ...LIVE_SUB,
        pausedAt: new Date("2026-11-08T09:00:00Z"),
      });
      await svc.transitionAndEmit(
        "t1",
        { status: { not: "ACTIVE" } },
        "ACTIVE",
        1,
        BILLING_EVENTS.SUBSCRIPTION_RESUMED,
        {},
      );
      expect(dunning.clearPauseAfterCommit).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "t1", stripeSubId: "sub_1" }),
      );
      expect(exit.tenantId).toBe("t1");
    });

    it("onExit hands the pause to the caller instead (the dunning resume throws on a Stripe error itself)", async () => {
      const { svc, tx, dunning } = make();
      tx.tenantSubscription.findUnique.mockResolvedValue({
        ...LIVE_SUB,
        pausedAt: new Date("2026-11-08T09:00:00Z"),
      });
      const seen: unknown[] = [];
      await svc.transitionAndEmit(
        "t1",
        { status: "READ_ONLY" },
        "ACTIVE",
        1,
        BILLING_EVENTS.SUBSCRIPTION_RESUMED,
        {},
        { onExit: (e) => seen.push(e) },
      );
      expect(seen).toHaveLength(1);
      expect(dunning.clearPauseAfterCommit).not.toHaveBeenCalled();
    });
  });

  describe("payment_succeeded never resumes a pause or revives a cancelled tenant", () => {
    const paid = (reason: string, status = "READ_ONLY") =>
      make({
        sub: {
          ...LIVE_SUB,
          failedPaymentCount: 0,
          tenant: { ...LIVE_SUB.tenant, status, readOnlyReason: reason },
        },
      });

    it("READ_ONLY(payment_overdue): stays paused, +0 (the resume is invoice.paid's, exactly once)", async () => {
      const { svc, tx, events } = paid("payment_overdue");
      await svc.handleWebhookEvent(invoiceEvent("invoice.payment_succeeded"));
      expect(tx.tenant.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it("READ_ONLY(subscription_cancelled) (paused -> cancel -> pay): stays cancelled, 0 delta", async () => {
      const { svc, tx, events } = paid("subscription_cancelled");
      await svc.handleWebhookEvent(invoiceEvent("invoice.payment_succeeded"));
      expect(tx.tenant.updateMany).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it("still reinstates a SUSPENDED tenant exactly as before (+MRR once)", async () => {
      const { svc, events } = paid("overdue", "SUSPENDED");
      await svc.handleWebhookEvent(invoiceEvent("invoice.payment_succeeded"));
      expect(eventsOfType(events, BILLING_EVENTS.SUBSCRIPTION_RESUMED)).toHaveLength(1);
    });
  });

  describe("a cancel while paused (Stripe's subscription.deleted)", () => {
    it("asks dunning to land the tenant on READ_ONLY(subscription_cancelled); it is never CANCELLED", async () => {
      const { svc, dunning, prisma, events } = make({ transitionCount: 0 });
      await svc.handleWebhookEvent({
        id: "evt_2",
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_1", customer: "cus_1" } },
      });
      expect(dunning.markCancelledWhilePaused).toHaveBeenCalledWith("t1");
      // the SUSPENDED -> CANCELLED CAS is the only other status write; it finds nothing, and no churn is booked
      expect(prisma.tenant.updateMany).toHaveBeenCalledWith({
        where: { id: "t1", status: "SUSPENDED" },
        data: { status: "CANCELLED" },
      });
      expect(eventsOfType(events, BILLING_EVENTS.SUBSCRIPTION_CANCELED)).toHaveLength(0);
    });
  });

  describe("checkout is refused while an invoice is overdue", () => {
    it("409 PAYMENT_OVERDUE with hosted_invoice_url; no Stripe checkout session is created", async () => {
      process.env.BILLING_PAUSE_MODE = "enforced";
      const { svc, prisma, stripe } = make();
      prisma.tenant.findUnique.mockResolvedValue({ id: "t1", slug: "acme", status: "READ_ONLY" });
      prisma.tenantSubscription.findUnique.mockResolvedValue({
        stripeSubId: null,
        externalPayment: false,
        catchupState: null,
        pastDueInvoiceId: "in_1",
      });
      const err: any = await svc.createCheckoutSession("t1").catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        code: "PAYMENT_OVERDUE",
        hosted_invoice_url: "https://pay.example.test/i/in_1",
      });
      expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  describe("pause -> resume with the REAL dunning service: the ledger nets to zero (-once, +once)", () => {
    const since = new Date("2026-11-01T00:00:00Z");
    const NOW = new Date("2026-11-08T09:00:00Z");
    const clocked = {
      ...LIVE_SUB,
      pastDueSince: since,
      pastDueInvoiceId: "in_1",
      externalPayment: false,
      catchupState: null,
      pausedAt: null,
    };
    const logged = [
      { milestone: "DUNNING_D0", sentAt: since },
      { milestone: "DUNNING_D3", sentAt: new Date("2026-11-04T00:00:00Z") },
      { milestone: "DUNNING_D6", sentAt: new Date("2026-11-07T00:00:00Z") },
      { milestone: "DUNNING_FINAL", sentAt: new Date("2026-11-07T00:00:00Z") },
    ];

    it("the sweep pauses with ONE -373 SUSPENDED row; invoice.paid resumes with ONE +373 RESUMED row", async () => {
      process.env.BILLING_PAUSE_MODE = "enforced";
      const h = make({
        realDunning: true,
        addons: [{ priceSnapshot: 12, quantity: 2 }],
        sweepRows: [clocked],
        logged,
      });
      const dunning = h.dunning as DunningService;

      const out = await dunning.sweep(NOW);
      expect(out.paused).toBe(1);
      expect(eventsOfType(h.events, BILLING_EVENTS.SUBSCRIPTION_SUSPENDED)).toHaveLength(1);
      expect(eventsOfType(h.events, BILLING_EVENTS.SUBSCRIPTION_SUSPENDED)[0][3].amountDelta).toBe(
        -373,
      );
      expect(h.tx.tenant.updateMany).toHaveBeenCalledWith({
        where: { status: "ACTIVE", id: "t1" },
        data: { readOnlyReason: "payment_overdue", status: "READ_ONLY" },
      });
      expect(h.stripe.updateSubscription).toHaveBeenCalledWith(
        "sub_1",
        { pause_collection: { behavior: "void" } },
        { idempotencyKey: `t1:pause:${NOW.toISOString()}` },
      );

      // invoice.paid for the clock invoice, nothing else open
      h.prisma.tenantSubscription.findFirst.mockResolvedValue({
        ...clocked,
        pausedAt: NOW,
        tenant: {
          status: "READ_ONLY",
          readOnlyReason: "payment_overdue",
          deletedAt: null,
          class: "PRODUCTION",
        },
      });
      h.tx.tenantSubscription.findUnique.mockResolvedValue({
        ...clocked,
        pausedAt: NOW,
      });
      await h.svc.handleWebhookEvent(invoiceEvent("invoice.paid"));
      const resumed = eventsOfType(h.events, BILLING_EVENTS.SUBSCRIPTION_RESUMED);
      expect(resumed).toHaveLength(1);
      expect(resumed[0][3].amountDelta).toBe(373);
      expect(h.stripe.updateSubscription).toHaveBeenCalledWith(
        "sub_1",
        { pause_collection: "" },
        expect.objectContaining({ idempotencyKey: expect.stringMatching(/^t1:unpause:/) }),
      );
    });

    it("dark with the same facts never touches status or the ledger", async () => {
      process.env.BILLING_PAUSE_MODE = "dark";
      const h = make({ realDunning: true, sweepRows: [clocked], logged });
      await (h.dunning as DunningService).sweep(NOW);
      expect(h.tx.tenant.updateMany).not.toHaveBeenCalled();
      expect(h.events.emit).not.toHaveBeenCalled();
    });
  });
});
