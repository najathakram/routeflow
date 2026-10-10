/**
 * SA-733r M2 / SA-733r7 r-note (3): the daily DISCOVERY sweep. `payment_failed` only stamps an invoice Stripe
 * actually attempted; an open invoice that was never attempted (marked "unpaid", a missing card, auto-collection
 * off) never raises the event and would run uncharged forever. Discovery lists each Stripe-billed tenant's open
 * invoices and stamps the oldest finalized-over-24-h one that has money remaining and no clock.
 */
import { DunningService } from "./dunning.service";

const NOW = new Date("2026-11-10T04:00:00Z");
const H = 3_600_000;
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const inv = (id: string, ageHours: number, over: Record<string, unknown> = {}) => ({
  id,
  status: "open",
  amount_remaining: 4900,
  created: sec(new Date(NOW.getTime() - (ageHours + 1) * H)),
  status_transitions: { finalized_at: sec(new Date(NOW.getTime() - ageHours * H)) },
  ...over,
});
const OPEN_FACTS = {
  status: "open",
  amountPaid: 0,
  amountDue: 4900,
  amountRemaining: 4900,
  paymentProcessing: false,
  nextPaymentAttempt: null,
  attemptCount: 0,
  subscriptionId: "sub_1",
};
const subRow = (tenantId: string, o: Record<string, unknown> = {}) => ({
  tenantId,
  stripeSubId: `sub_${tenantId}`,
  externalPayment: false,
  catchupState: null,
  pastDueInvoiceId: null,
  ...o,
});

function make(
  opts: {
    rows?: any[];
    invoices?: Record<string, any[]>;
    facts?: any;
    casCount?: number;
  } = {},
) {
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenantSubscription: { updateMany: jest.fn().mockResolvedValue({ count: opts.casCount ?? 1 }) },
  };
  const rows = opts.rows ?? [];
  const prisma: any = {
    getTenantId: () => null,
    tenantSubscription: {
      count: jest.fn(async () => rows.length),
      findMany: jest.fn(async (args: any) => {
        let r = [...rows].sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));
        const w = args?.where?.tenantId;
        if (w?.gt) r = r.filter((x) => x.tenantId > w.gt);
        if (w?.lte) r = r.filter((x) => x.tenantId <= w.lte);
        if (args?.skip) r = r.slice(args.skip);
        if (args?.take) r = r.slice(0, args.take);
        return r;
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const stripe: any = {
    isConfigured: true,
    listOpenSubscriptionInvoices: jest.fn(async (subId: string) => opts.invoices?.[subId] ?? []),
    getInvoiceFacts: jest.fn().mockResolvedValue(opts.facts ?? OPEN_FACTS),
  };
  const notifications: any = {
    notifyDunning: jest.fn().mockResolvedValue({ status: "sent", recipients: 1 }),
    recordDunningMilestone: jest.fn(),
    localDateLabel: jest.fn(),
  };
  const svc = new DunningService(prisma, stripe, notifications, { invalidate: jest.fn() } as any);
  svc.bindTransition((async () => true) as any);
  return { svc, prisma, tx, stripe, notifications };
}

describe("DunningService.discover (daily open-invoice discovery)", () => {
  const saved = process.env.BILLING_PAUSE_MODE;
  beforeEach(() => {
    process.env.BILLING_PAUSE_MODE = "dark";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = saved;
  });

  it("a never-attempted open invoice finalized 25 h ago is stamped, once, under the Tenant lock, from its finalization time", async () => {
    const d = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 25)] } });
    const out = await d.svc.discover(NOW);
    expect(out).toMatchObject({ tenants: 1, stamped: 1, failed: 0 });
    expect(d.tx.$queryRaw).toHaveBeenCalled();
    expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", pastDueInvoiceId: null, catchupState: null },
      data: { pastDueSince: new Date(NOW.getTime() - 25 * H), pastDueInvoiceId: "in_a" },
    });
  });

  it("23 h old is NOT stamped (Stripe may still be about to collect it)", async () => {
    const d = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 23)] } });
    expect((await d.svc.discover(NOW)).stamped).toBe(0);
    expect(d.stripe.getInvoiceFacts).not.toHaveBeenCalled();
  });

  it("stamps the OLDEST qualifying invoice only (one clock per tenant)", async () => {
    const d = make({
      rows: [subRow("t1")],
      invoices: { sub_t1: [inv("in_old", 100), inv("in_new", 30)] },
    });
    await d.svc.discover(NOW);
    expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledTimes(1);
    expect(d.tx.tenantSubscription.updateMany.mock.calls[0][0].data.pastDueInvoiceId).toBe(
      "in_old",
    );
  });

  it("a tenant that already has a clock is not in the population (and a lost CAS stamps nothing)", async () => {
    const d = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 30)] }, casCount: 0 });
    expect(d.prisma.tenantSubscription.count).not.toHaveBeenCalled();
    const out = await d.svc.discover(NOW);
    expect(d.prisma.tenantSubscription.count.mock.calls[0][0].where).toMatchObject({
      pastDueInvoiceId: null,
    });
    expect(out.stamped).toBe(0); // another writer stamped it between the read and the lock
  });

  it("the population is Stripe-billed, not manual-pay, no catch-up claim, not deleted - and there is no couponFull exemption", async () => {
    const d = make({ rows: [] });
    await d.svc.discover(NOW);
    expect(d.prisma.tenantSubscription.count.mock.calls[0][0].where).toEqual({
      stripeSubId: { not: null },
      externalPayment: false,
      catchupState: null,
      pastDueInvoiceId: null,
      tenant: { deletedAt: null },
    });
    const coupon = make({
      rows: [subRow("t1", { couponFull: true })],
      invoices: { sub_t1: [inv("in_a", 30)] },
    });
    expect((await coupon.svc.discover(NOW)).stamped).toBe(1);
  });

  it("belt and braces: a catch-up or manual-pay row that reaches the loop is skipped before any Stripe call", async () => {
    const d = make({
      rows: [
        subRow("t1", { catchupState: "SESSION_OPEN" }),
        subRow("t2", { externalPayment: true }),
        subRow("t3", { stripeSubId: null }),
      ],
      invoices: { sub_t1: [inv("in_a", 30)], sub_t2: [inv("in_b", 30)] },
    });
    const out = await d.svc.discover(NOW);
    expect(out.stamped).toBe(0);
    expect(d.stripe.listOpenSubscriptionInvoices).not.toHaveBeenCalled();
  });

  it("only OPEN invoices with money remaining qualify: paid / void / uncollectible / zero-remaining are ignored", async () => {
    const d = make({
      rows: [subRow("t1")],
      invoices: {
        sub_t1: [
          inv("in_paid", 40, { status: "paid", amount_remaining: 0 }),
          inv("in_void", 40, { status: "void" }),
          inv("in_unc", 40, { status: "uncollectible" }),
          inv("in_zero", 40, { amount_remaining: 0 }),
        ],
      },
    });
    expect((await d.svc.discover(NOW)).stamped).toBe(0);
    expect(d.stripe.getInvoiceFacts).not.toHaveBeenCalled();
  });

  it("re-reads the invoice before stamping (M8 / N6): paid since the list, or a payment still processing = no stamp", async () => {
    const paid = make({
      rows: [subRow("t1")],
      invoices: { sub_t1: [inv("in_a", 30)] },
      facts: { ...OPEN_FACTS, status: "paid", amountPaid: 4900, amountRemaining: 0 },
    });
    expect((await paid.svc.discover(NOW)).stamped).toBe(0);
    const processing = make({
      rows: [subRow("t1")],
      invoices: { sub_t1: [inv("in_a", 30)] },
      facts: { ...OPEN_FACTS, paymentProcessing: true },
    });
    expect((await processing.svc.discover(NOW)).stamped).toBe(0);
  });

  it("BILLING_PAUSE_MODE=off does nothing at all; dark stamps (like payment_failed); enforced stamps", async () => {
    process.env.BILLING_PAUSE_MODE = "off";
    const off = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 30)] } });
    expect(await off.svc.discover(NOW)).toEqual({ tenants: 0, stamped: 0, failed: 0 });
    expect(off.prisma.tenantSubscription.count).not.toHaveBeenCalled();
    for (const m of ["dark", "enforced"]) {
      process.env.BILLING_PAUSE_MODE = m;
      const d = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 30)] } });
      expect((await d.svc.discover(NOW)).stamped).toBe(1);
    }
  });

  it("sends no email itself (the hourly sweep owns the reminders) and never changes a status", async () => {
    const d = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 30)] } });
    await d.svc.discover(NOW);
    expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
  });

  it("one tenant's Stripe error is isolated and counted; the next tenant is still discovered", async () => {
    const d = make({
      rows: [subRow("t1"), subRow("t2")],
      invoices: { sub_t2: [inv("in_b", 30)] },
    });
    d.stripe.listOpenSubscriptionInvoices.mockRejectedValueOnce(new Error("stripe down"));
    const out = await d.svc.discover(NOW);
    expect(out).toMatchObject({ tenants: 2, stamped: 1, failed: 1 });
  });

  it("pages the whole population by keyset, bounded per run, rotating by day so every tenant is reached", async () => {
    const rows = ["t1", "t2", "t3", "t4", "t5"].map((t) => subRow(t));
    const seen = new Set<string>();
    for (let day = 0; day < 3; day++) {
      const d = make({ rows });
      await d.svc.discover(new Date(NOW.getTime() + day * 24 * H), { maxTenants: 2, batchSize: 2 });
      for (const c of d.stripe.listOpenSubscriptionInvoices.mock.calls) seen.add(c[0]);
    }
    expect([...seen].sort()).toEqual(["sub_t1", "sub_t2", "sub_t3", "sub_t4", "sub_t5"]);
  });

  it("is a @LeaderCron at 04:00 (billing.dunningDiscovery)", () => {
    // structural: pinned in dunning-structural.spec.ts and no-bare-cron.spec.ts; here, the entry point exists
    expect(
      typeof new DunningService({} as any, {} as any, {} as any, {} as any).dunningDiscovery,
    ).toBe("function");
  });
});
