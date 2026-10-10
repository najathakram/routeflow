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
    /** getInvoiceFacts per invoice id (phase 2 re-reads the CLOCKED invoice) */
    factsById?: Record<string, any>;
    casCount?: number;
  } = {},
) {
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenantSubscription: { updateMany: jest.fn().mockResolvedValue({ count: opts.casCount ?? 1 }) },
  };
  const wantsClock = (a: any) => a?.where?.pastDueInvoiceId !== null; // null = phase 1, {not:null} = phase 2
  const rows = opts.rows ?? [];
  const prisma: any = {
    getTenantId: () => null,
    tenantSubscription: {
      count: jest.fn(
        async (args: any) =>
          rows.filter((x) => (x.pastDueInvoiceId != null) === wantsClock(args)).length,
      ),
      findMany: jest.fn(async (args: any) => {
        let r = [...rows]
          .filter((x) => (x.pastDueInvoiceId != null) === wantsClock(args))
          .sort((a, b) => (a.tenantId < b.tenantId ? -1 : 1));
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
    getInvoiceFacts: jest.fn(
      async (id: string) => opts.factsById?.[id] ?? opts.facts ?? OPEN_FACTS,
    ),
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

/** A DunningService wired to ONE clocked row, as the stamp left it, with this episode's notice log. */
function sweepWorld(
  stamped: { pastDueSince: Date; pastDueInvoiceId: string },
  finalSentAt: Date | null,
  history: any[] = [],
) {
  const key = `${stamped.pastDueInvoiceId}:${stamped.pastDueSince.toISOString()}`;
  const logs = [
    ...history,
    ...(finalSentAt
      ? [
          { milestone: "DUNNING_D0", sentAt: stamped.pastDueSince, key },
          { milestone: "DUNNING_D3", sentAt: stamped.pastDueSince, key },
          { milestone: "DUNNING_D6", sentAt: finalSentAt, key },
          { milestone: "DUNNING_FINAL", sentAt: finalSentAt, key },
        ]
      : []),
  ];
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenant: { findUnique: jest.fn().mockResolvedValue({ status: "ACTIVE" }) },
    tenantSubscription: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({ pausedAt: null }),
    },
  };
  const prisma: any = {
    getTenantId: () => null,
    tenantSubscription: {
      findMany: jest.fn().mockResolvedValue([
        {
          tenantId: "t1",
          stripeSubId: "sub_t1",
          externalPayment: false,
          catchupState: null,
          pastDueSince: stamped.pastDueSince,
          pastDueInvoiceId: stamped.pastDueInvoiceId,
          pausedAt: null,
          tenant: {
            status: "ACTIVE",
            readOnlyReason: null,
            deletedAt: null,
            class: "PRODUCTION",
          },
        },
      ]),
      findUnique: jest.fn().mockResolvedValue({ pausedAt: null }),
    },
    tenantConfig: { findUnique: jest.fn().mockResolvedValue({ timezone: "UTC" }) },
    billingNotificationLog: {
      findMany: jest.fn(async (a: any) => logs.filter((l) => l.key === a.where.key)),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const stripe: any = {
    isConfigured: true,
    getInvoiceFacts: jest.fn().mockResolvedValue(OPEN_FACTS),
    updateSubscription: jest.fn().mockResolvedValue({}),
  };
  const notifications: any = {
    notifyDunning: jest.fn().mockResolvedValue({ status: "sent", recipients: 1 }),
    recordDunningMilestone: jest.fn(),
    localDateLabel: jest.fn().mockResolvedValue("x"),
  };
  const transition = jest.fn(async () => true);
  const svc = new DunningService(prisma, stripe, notifications, {
    invalidate: jest.fn(),
  } as any);
  svc.bindTransition(transition as any);
  return { svc, transition, notifications };
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

  it("a never-attempted open invoice finalized 25 h ago is stamped, once, under the Tenant lock, with the STAMP time as the clock start", async () => {
    const d = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 25)] } });
    const out = await d.svc.discover(NOW);
    expect(out).toMatchObject({ tenants: 1, stamped: 1, failed: 0 });
    expect(d.tx.$queryRaw).toHaveBeenCalled();
    expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", pastDueInvoiceId: null, catchupState: null },
      data: { pastDueSince: NOW, pastDueInvoiceId: "in_a" },
    });
  });

  describe("a 40-day-old never-attempted invoice gets a FULL runway (a REAL hourly sweep decides)", () => {
    it("discovery stamps the STAMP time; the sweep does NOT pause at +167 h and DOES at +168 h", async () => {
      process.env.BILLING_PAUSE_MODE = "enforced";
      const d = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_old", 40 * 24)] } });
      await d.svc.discover(NOW);
      const stamped = d.tx.tenantSubscription.updateMany.mock.calls[0][0].data;
      expect(stamped).toEqual({ pastDueSince: NOW, pastDueInvoiceId: "in_old" });

      // this episode's final notice went out at +144 h; NOW is 04:00 UTC so the pause hour is reached at both checks
      const finalAt = new Date(NOW.getTime() + 144 * H);
      const early = sweepWorld(stamped, finalAt);
      expect((await early.svc.sweep(new Date(NOW.getTime() + 167 * H))).paused).toBe(0);
      expect(early.transition).not.toHaveBeenCalled();
      const due = sweepWorld(stamped, finalAt);
      expect((await due.svc.sweep(new Date(NOW.getTime() + 168 * H))).paused).toBe(1);
    });
  });

  it("(i) exit + re-stamp of the SAME invoice: a new stamp time, a new notice key, d0 goes out again and nothing from episode 1 is reused", async () => {
    process.env.BILLING_PAUSE_MODE = "enforced";
    // episode 1: discovery stamps in_a, the sweeps send d0/d3/d6/final, then the tenant is activated (clock cleared)
    const first = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 30)] } });
    await first.svc.discover(NOW);
    const s1 = first.tx.tenantSubscription.updateMany.mock.calls[0][0].data;
    const key1 = `in_a:${s1.pastDueSince.toISOString()}`;
    const history = [
      "DUNNING_D0",
      "DUNNING_D3",
      "DUNNING_D6",
      "DUNNING_FINAL",
      "DUNNING_PAUSED",
    ].map((m) => ({ milestone: m, sentAt: NOW, key: key1 }));

    // episode 2: the invoice is still open; a later discovery stamps it again
    const later = new Date(NOW.getTime() + 9 * 24 * H);
    const second = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 30 + 9 * 24)] } });
    await second.svc.discover(later);
    const s2 = second.tx.tenantSubscription.updateMany.mock.calls[0][0].data;
    expect(s2).toEqual({ pastDueSince: later, pastDueInvoiceId: "in_a" });
    const key2 = `in_a:${later.toISOString()}`;
    expect(key2).not.toBe(key1);

    // the hourly sweep one hour into episode 2 mails d0 under the NEW key, whatever episode 1 left in the log
    const w = sweepWorld(s2, null, history);
    await w.svc.sweep(new Date(later.getTime() + H));
    expect(w.notifications.notifyDunning).toHaveBeenCalledTimes(1);
    expect(w.notifications.notifyDunning).toHaveBeenCalledWith(
      "t1",
      "DUNNING_D0",
      key2,
      "d0",
      expect.anything(),
    );
  });

  it("a YOUNG invoice (2 h) that Stripe already attempted IS owed: discovery stamps it; one it never attempted is left alone", async () => {
    const tried = make({
      rows: [subRow("t1")],
      invoices: { sub_t1: [inv("in_a", 2, { attempt_count: 1 })] },
    });
    expect((await tried.svc.discover(NOW)).stamped).toBe(1);
    const untried = make({
      rows: [subRow("t1")],
      invoices: { sub_t1: [inv("in_a", 2, { attempt_count: 0 })] },
    });
    expect((await untried.svc.discover(NOW)).stamped).toBe(0);
  });

  it("logs the finalization time with the stamp (structured, for the report)", async () => {
    const d = make({ rows: [subRow("t1")], invoices: { sub_t1: [inv("in_a", 30)] } });
    const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
    await d.svc.discover(NOW);
    const line = String(
      warn.mock.calls.map((c: any[]) => c[0]).find((l: string) => /clock_started/.test(l)),
    );
    expect(line).toContain("invoice=in_a");
    expect(line).toContain(`stampAt=${NOW.toISOString()}`);
    expect(line).toContain(`finalizedAt=${new Date(NOW.getTime() - 30 * H).toISOString()}`);
    // never attempted by Stripe: there is no failure to date, and the log says so instead of a bare "none"
    expect(line).toContain("attempts=0");
    expect(line).toContain("firstFailureAt=never_attempted");
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
    expect(await off.svc.discover(NOW)).toEqual({
      tenants: 0,
      clocks: 0,
      stamped: 0,
      failed: 0,
      cleared: 0,
      moved: 0,
    });
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

  it("pages the whole population by keyset: each tenant is listed EXACTLY once per run, the budget bounds a run, and the start wraps past the end", async () => {
    const rows = ["t1", "t2", "t3", "t4", "t5"].map((t) => subRow(t));
    const seen = new Set<string>();
    let wrapped = false;
    for (let day = 0; day < 6; day++) {
      const d = make({ rows });
      await d.svc.discover(new Date(NOW.getTime() + day * 24 * H), { maxTenants: 2, batchSize: 2 });
      const listed: string[] = d.stripe.listOpenSubscriptionInvoices.mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(listed).toHaveLength(2); // bounded by the budget
      expect(new Set(listed).size).toBe(listed.length); // never twice in one run
      for (const id of listed) seen.add(id);
      if (listed.includes("sub_t5") && listed.includes("sub_t1")) wrapped = true; // [t5, t1]: past the end, to the start
    }
    expect([...seen].sort()).toEqual(["sub_t1", "sub_t2", "sub_t3", "sub_t4", "sub_t5"]);
    expect(wrapped).toBe(true);
  });

  describe("phase 2: the clocked invoice left OPEN while the tenant is ACTIVE (void / uncollectible)", () => {
    const clocked = (id: string, o: Record<string, unknown> = {}) =>
      subRow(id, { pastDueInvoiceId: `in_clock_${id}`, ...o });
    const VOID = { ...OPEN_FACTS, status: "void" };

    it("clears the clock when nothing else is open - no status change, no MRR, no email", async () => {
      const d = make({
        rows: [clocked("t1")],
        factsById: { in_clock_t1: VOID },
        invoices: { sub_t1: [] },
      });
      const out = await d.svc.discover(NOW);
      expect(out).toMatchObject({ cleared: 1, moved: 0, stamped: 0 });
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", pastDueInvoiceId: "in_clock_t1", pausedAt: null },
        data: { pastDueSince: null, pastDueInvoiceId: null, pausedAt: null },
      });
      expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
    });

    it("an UNCOLLECTIBLE clocked invoice is cleared the same way (the owner's write-off)", async () => {
      const d = make({
        rows: [clocked("t1")],
        factsById: { in_clock_t1: { ...OPEN_FACTS, status: "uncollectible" } },
      });
      expect((await d.svc.discover(NOW)).cleared).toBe(1);
    });

    it("moves the clock to the oldest still-open owed invoice, restarting at the move time (its d0 never went out)", async () => {
      const d = make({
        rows: [clocked("t1")],
        factsById: { in_clock_t1: VOID },
        invoices: { sub_t1: [inv("in_sib", 50), inv("in_sib2", 30)] },
      });
      const out = await d.svc.discover(NOW);
      expect(out).toMatchObject({ moved: 1, cleared: 0 });
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", pastDueInvoiceId: "in_clock_t1", pausedAt: null },
        data: { pastDueInvoiceId: "in_sib", pastDueSince: NOW },
      });
    });

    it("phase 2 does not double count tenants: `tenants` is phase 1, `clocks` is phase 2", async () => {
      const d = make({
        rows: [subRow("t1"), clocked("t2")],
        invoices: { sub_t1: [] },
        factsById: { in_clock_t2: OPEN_FACTS },
      });
      expect(await d.svc.discover(NOW)).toMatchObject({ tenants: 1, clocks: 1 });
    });

    it("a lost CAS (invoice.paid / a new stamp / a pause landed between the read and the update): nothing cleared or moved, nothing logged", async () => {
      const d = make({
        rows: [clocked("t1")],
        factsById: { in_clock_t1: VOID },
        casCount: 0,
      });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      const out = await d.svc.discover(NOW);
      expect(out).toMatchObject({ cleared: 0, moved: 0, failed: 0 });
      expect(
        warn.mock.calls.some((c: any[]) => /clock_cleared|clock_started/.test(String(c[0]))),
      ).toBe(false);
      // and the update itself was guarded on the exact clock and on the tenant not being paused
      expect(d.tx.tenantSubscription.updateMany.mock.calls[0][0].where).toEqual({
        tenantId: "t1",
        pastDueInvoiceId: "in_clock_t1",
        pausedAt: null,
      });
    });

    it("a YOUNG sibling that Stripe already attempted IS a move target (the one owed rule: age OR attempted)", async () => {
      const d = make({
        rows: [clocked("t1")],
        factsById: { in_clock_t1: VOID },
        invoices: { sub_t1: [inv("in_young", 2, { attempt_count: 2 })] },
      });
      expect(await d.svc.discover(NOW)).toMatchObject({ moved: 1, cleared: 0 });
      expect(d.tx.tenantSubscription.updateMany.mock.calls[0][0].data).toEqual({
        pastDueInvoiceId: "in_young",
        pastDueSince: NOW,
      });
    });

    it("a moved-to sibling must pass the SAME minimum-age filter as phase 1: a young sibling is not a target, so the clock is cleared", async () => {
      const d = make({
        rows: [clocked("t1")],
        factsById: { in_clock_t1: VOID },
        invoices: { sub_t1: [inv("in_young", 5)] }, // finalized 5 h ago: Stripe may still be about to collect it
      });
      expect(await d.svc.discover(NOW)).toMatchObject({ cleared: 1, moved: 0 });
    });

    it("leaves a clock alone while its invoice is still open, and leaves a PAID one to invoice.paid", async () => {
      const open = make({ rows: [clocked("t1")], factsById: { in_clock_t1: OPEN_FACTS } });
      const o1 = await open.svc.discover(NOW);
      expect(o1).toMatchObject({ cleared: 0, moved: 0 });
      const paid = make({
        rows: [clocked("t1")],
        factsById: {
          in_clock_t1: { ...OPEN_FACTS, status: "paid", amountRemaining: 0, amountPaid: 4900 },
        },
      });
      expect(await paid.svc.discover(NOW)).toMatchObject({ cleared: 0, moved: 0 });
      expect(paid.tx.tenantSubscription.updateMany).not.toHaveBeenCalled();
    });

    it("only ACTIVE, unpaused, Stripe-billed, non-manual, no-claim tenants are in the population (a PAUSED tenant's exit stays admin activation)", async () => {
      const d = make({ rows: [] });
      await d.svc.discover(NOW);
      const wheres = d.prisma.tenantSubscription.count.mock.calls.map((c: any[]) => c[0].where);
      expect(wheres).toContainEqual({
        stripeSubId: { not: null },
        externalPayment: false,
        catchupState: null,
        pastDueInvoiceId: { not: null },
        pausedAt: null,
        tenant: { deletedAt: null, status: "ACTIVE" },
      });
    });

    it("never touches status or the ledger (no transition is bound at all)", async () => {
      const d = make({ rows: [clocked("t1")], factsById: { in_clock_t1: VOID } });
      (d.svc as any).transition = null;
      await expect(d.svc.discover(NOW)).resolves.toMatchObject({ cleared: 1 });
    });

    it("BILLING_PAUSE_MODE=off skips phase 2 too", async () => {
      process.env.BILLING_PAUSE_MODE = "off";
      const d = make({ rows: [clocked("t1")], factsById: { in_clock_t1: VOID } });
      expect(await d.svc.discover(NOW)).toEqual({
        tenants: 0,
        clocks: 0,
        stamped: 0,
        failed: 0,
        cleared: 0,
        moved: 0,
      });
    });
  });

  it("is a @LeaderCron at 04:00 (billing.dunningDiscovery)", () => {
    // structural: pinned in dunning-structural.spec.ts and no-bare-cron.spec.ts; here, the entry point exists
    expect(
      typeof new DunningService({} as any, {} as any, {} as any, {} as any).dunningDiscovery,
    ).toBe("function");
  });
});
