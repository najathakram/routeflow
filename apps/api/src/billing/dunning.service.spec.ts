import { DunningService } from "./dunning.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

/**
 * SA-733r7 PR-B3: the dunning service against mocked Prisma / Stripe / notifications. DB-level concurrency
 * (two sweeps racing, a sweep racing invoice.paid) lives in dunning.db.spec.ts.
 */

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

const row = (o: Record<string, unknown> = {}) => ({
  tenantId: "t1",
  stripeSubId: "sub_1",
  externalPayment: false,
  catchupState: null,
  pastDueSince: new Date("2026-11-01T00:00:00Z"),
  pastDueInvoiceId: "in_1",
  pausedAt: null,
  tenant: { status: "ACTIVE", readOnlyReason: null, deletedAt: null, class: "PRODUCTION" },
  ...o,
});

const invoice = (o: Record<string, unknown> = {}) => ({
  id: "in_1",
  customer: "cus_1",
  parent: { subscription_details: { subscription: "sub_1" } },
  ...o,
});

function make(
  opts: {
    row?: any;
    sweepRows?: any[];
    facts?: any;
    tz?: string | null;
    logged?: { milestone: string; sentAt: Date }[];
    subCasCount?: number;
    transitionResult?: boolean;
    exit?: any;
    stripeSub?: any;
    openInvoices?: any[];
    localPausedAt?: Date | null;
    /** The tenant row as the resume transaction re-reads it UNDER the Tenant lock. */
    txTenant?: { status: string; readOnlyReason: string | null };
    /** The owed marker as the resume transaction re-reads it under the lock (default: still in_1). */
    txClock?: string | null;
  } = {},
) {
  const order: string[] = [];
  const tx: any = {
    $queryRaw: jest.fn().mockImplementation(async () => {
      order.push("lock");
      return [];
    }),
    tenant: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.txTenant ?? { status: "ACTIVE", readOnlyReason: null }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    tenantSubscription: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.subCasCount ?? 1 }),
      findUnique: jest.fn().mockResolvedValue({
        pausedAt: opts.localPausedAt ?? null,
        stripeSubId: "sub_1",
        pastDueInvoiceId: opts.txClock === undefined ? "in_1" : opts.txClock,
      }),
    },
  };
  const prisma: any = {
    getTenantId: () => null,
    tenantSubscription: {
      findFirst: jest.fn().mockResolvedValue(opts.row === undefined ? row() : opts.row),
      // a keyset-aware fake: the reconciler pages with { tenantId: { gt | lte }, take, skip }; the sweep passes none
      findMany: jest.fn(async (args: any) => {
        let rows: any[] = [...(opts.sweepRows ?? [])].sort((a, b) =>
          a.tenantId < b.tenantId ? -1 : 1,
        );
        const w = args?.where?.tenantId;
        if (w?.gt) rows = rows.filter((r) => r.tenantId > w.gt);
        if (w?.lte) rows = rows.filter((r) => r.tenantId <= w.lte);
        if (args?.skip) rows = rows.slice(args.skip);
        if (args?.take) rows = rows.slice(0, args.take);
        return rows;
      }),
      count: jest.fn(async () => (opts.sweepRows ?? []).length),
      findUnique: jest.fn().mockResolvedValue({ pausedAt: opts.localPausedAt ?? null }),
    },
    tenantConfig: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ timezone: opts.tz === undefined ? "UTC" : opts.tz }),
    },
    billingNotificationLog: { findMany: jest.fn().mockResolvedValue(opts.logged ?? []) },
    $transaction: jest.fn(async (fn: any) => {
      const r = await fn(tx);
      order.push("commit");
      return r;
    }),
  };
  const stripe: any = {
    isConfigured: true,
    getInvoiceFacts: jest.fn().mockResolvedValue(opts.facts ?? OPEN_FACTS),
    listOwedSubscriptionInvoices: jest.fn().mockResolvedValue(opts.openInvoices ?? []),
    getSubscription: jest.fn().mockResolvedValue(opts.stripeSub ?? { status: "active" }),
    updateSubscription: jest.fn().mockImplementation(async () => {
      order.push("stripe");
      return {};
    }),
  };
  const notifications: any = {
    notifyDunning: jest.fn().mockResolvedValue({ status: "sent", recipients: 1 }),
    recordDunningMilestone: jest.fn().mockResolvedValue(true),
    localDateLabel: jest.fn().mockResolvedValue("Nov 9, 2026"),
  };
  const guard: any = { invalidate: jest.fn() };
  const transition = jest.fn(async (...args: any[]) => {
    const o = args[6];
    if (args[2] === "ACTIVE" && opts.exit !== undefined) o?.onExit?.(opts.exit);
    order.push("transition");
    return opts.transitionResult ?? true;
  });
  const svc = new DunningService(prisma, stripe, notifications, guard);
  svc.bindTransition(transition as any);
  return { svc, prisma, tx, stripe, notifications, guard, transition, order };
}

const mode = (m: string | undefined) => {
  if (m === undefined) delete process.env.BILLING_PAUSE_MODE;
  else process.env.BILLING_PAUSE_MODE = m;
};

describe("DunningService", () => {
  const saved = process.env.BILLING_PAUSE_MODE;
  afterEach(() => mode(saved));

  // ─── the stamp ────────────────────────────────────────────────────────────

  describe("invoice.payment_failed: the clock is stamped once per invoice", () => {
    const now = new Date("2026-11-01T14:00:00Z");

    it("stamps pastDueSince + pastDueInvoiceId, then sends the d0 notice (B410's direct email is gone)", async () => {
      mode("dark");
      const d = make({ row: row({ pastDueInvoiceId: null, pastDueSince: null }) });
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("stamped");
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", pastDueInvoiceId: null, catchupState: null },
        data: { pastDueSince: now, pastDueInvoiceId: "in_1" },
      });
      expect(d.tx.$queryRaw).toHaveBeenCalled(); // Tenant FOR UPDATE first
      expect(d.notifications.notifyDunning).toHaveBeenCalledWith(
        "t1",
        "DUNNING_D0",
        "in_1",
        "d0",
        expect.objectContaining({ payUrl: "https://pay.example.test/i/in_1" }),
      );
      expect(d.transition).not.toHaveBeenCalled(); // dark: no status change, ever
    });

    it("matches invoice -> row by stripeInvoiceSubscriptionId == stripeSubId (dahlia has no invoice.subscription)", async () => {
      mode("dark");
      const d = make({ row: row({ pastDueInvoiceId: null }) });
      await d.svc.onPaymentFailed(invoice(), now);
      expect(d.prisma.tenantSubscription.findFirst.mock.calls[0][0].where).toEqual({
        stripeSubId: "sub_1",
      });
      // an invoice with no subscription at all (a one-off) is not a dunning event
      const e = make();
      expect(await e.svc.onPaymentFailed({ id: "in_9" }, now)).toBe("ignored");
      expect(e.prisma.tenantSubscription.findFirst).not.toHaveBeenCalled();
    });

    it("is replay-idempotent: a second failure of the SAME invoice changes nothing and reads no Stripe", async () => {
      mode("dark");
      const d = make({ row: row() }); // already stamped for in_1
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("unchanged");
      expect(d.stripe.getInvoiceFacts).not.toHaveBeenCalled();
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("a second invoice failing while one is owed leaves the older clock (CAS on pastDueInvoiceId null)", async () => {
      mode("dark");
      const d = make({ row: row({ pastDueInvoiceId: "in_0" }), subCasCount: 0 });
      expect(await d.svc.onPaymentFailed(invoice({ id: "in_2" }), now)).toBe("unchanged");
      expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
    });

    it("skips a tenant whose catch-up claim is held", async () => {
      mode("dark");
      const d = make({
        row: row({ catchupState: "AWAITING_FIRST_PAYMENT", pastDueInvoiceId: null }),
      });
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("skipped");
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
      expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
    });

    it("never stamps a manual-pay (externalPayment) tenant", async () => {
      mode("dark");
      const d = make({ row: row({ externalPayment: true, pastDueInvoiceId: null }) });
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("skipped");
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("never stamps a row with no stripeSubId (nothing matches an invoice's subscription)", async () => {
      mode("dark");
      const d = make({ row: row({ stripeSubId: null, pastDueInvoiceId: null }) });
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("ignored");
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
      const none = make({ row: null });
      expect(await none.svc.onPaymentFailed(invoice(), now)).toBe("ignored");
    });

    it("has NO couponFull exemption: a coupon tenant whose invoice fails is stamped", async () => {
      mode("dark");
      const d = make({ row: row({ couponFull: true, pastDueInvoiceId: null }) });
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("stamped");
    });

    it("re-reads Stripe first (M8): a failed event for an invoice that is now paid stamps nothing", async () => {
      mode("dark");
      const d = make({
        row: row({ pastDueInvoiceId: null }),
        facts: { ...OPEN_FACTS, status: "paid", amountPaid: 4900, amountRemaining: 0 },
      });
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("not_owed");
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
      expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
    });

    it("a bank debit still processing is not a failure (N6): no stamp, no email", async () => {
      mode("dark");
      const d = make({
        row: row({ pastDueInvoiceId: null }),
        facts: { ...OPEN_FACTS, paymentProcessing: true },
      });
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("not_owed");
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("off mode stamps nothing", async () => {
      mode("off");
      const d = make({ row: row({ pastDueInvoiceId: null }) });
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("off");
      expect(d.prisma.tenantSubscription.findFirst).not.toHaveBeenCalled();
    });

    it("an unreadable Stripe throws (the webhook is redelivered) and stamps nothing", async () => {
      mode("dark");
      const d = make({ row: row({ pastDueInvoiceId: null }) });
      d.stripe.getInvoiceFacts.mockRejectedValue(new Error("stripe down"));
      await expect(d.svc.onPaymentFailed(invoice(), now)).rejects.toThrow("stripe down");
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("a failing d0 email never fails the webhook", async () => {
      mode("dark");
      const d = make({ row: row({ pastDueInvoiceId: null }) });
      d.notifications.notifyDunning.mockRejectedValue(new Error("smtp"));
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("stamped");
    });
  });

  // ─── the reminders ────────────────────────────────────────────────────────

  describe("the hourly sweep: d0 / d3 / d6 milestones keyed (tenant, milestone, invoiceId)", () => {
    const since = new Date("2026-11-01T00:00:00Z");
    const at = (hours: number) => new Date(since.getTime() + hours * 3_600_000);
    const sentMilestones = (d: ReturnType<typeof make>) =>
      d.notifications.notifyDunning.mock.calls.map((c: any[]) => [c[1], c[2], c[3]]);

    it("at +1 h only d0 is due", async () => {
      mode("dark");
      const d = make({ sweepRows: [row()] });
      await d.svc.sweep(at(1));
      expect(sentMilestones(d)).toEqual([["DUNNING_D0", "in_1", "d0"]]);
    });

    it("at +80 h d0 and d3 are due; d6 is not", async () => {
      mode("dark");
      const d = make({ sweepRows: [row()] });
      await d.svc.sweep(at(80));
      expect(sentMilestones(d)).toEqual([
        ["DUNNING_D0", "in_1", "d0"],
        ["DUNNING_D3", "in_1", "d3"],
      ]);
    });

    it("at +150 h in dark: d6 names no date; there is no final notice and no pause", async () => {
      mode("dark");
      const d = make({
        sweepRows: [row()],
        logged: [
          { milestone: "DUNNING_D0", sentAt: at(0) },
          { milestone: "DUNNING_D3", sentAt: at(72) },
        ],
      });
      await d.svc.sweep(at(150));
      expect(sentMilestones(d)).toEqual([["DUNNING_D6", "in_1", "d6"]]);
      expect(d.notifications.recordDunningMilestone).not.toHaveBeenCalled();
    });

    it("an already-logged milestone is never re-sent (the sweep is hourly)", async () => {
      mode("dark");
      const d = make({
        sweepRows: [row()],
        logged: [
          { milestone: "DUNNING_D0", sentAt: at(0) },
          { milestone: "DUNNING_D3", sentAt: at(72) },
          { milestone: "DUNNING_D6", sentAt: at(144) },
        ],
      });
      await d.svc.sweep(at(151));
      expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
    });

    it("enforced at +150 h: the d6 email IS the final notice ('read-only tomorrow') and records dunning_final", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row()],
        logged: [
          { milestone: "DUNNING_D0", sentAt: at(0) },
          { milestone: "DUNNING_D3", sentAt: at(72) },
        ],
      });
      await d.svc.sweep(at(150));
      expect(d.notifications.notifyDunning).toHaveBeenCalledWith(
        "t1",
        "DUNNING_D6",
        "in_1",
        "final",
        expect.objectContaining({ readOnlyOn: "Nov 9, 2026" }),
      );
      expect(d.notifications.recordDunningMilestone).toHaveBeenCalledWith(
        "t1",
        "DUNNING_FINAL",
        "in_1",
      );
      expect(d.transition).not.toHaveBeenCalled();
    });

    it("flipping dark -> enforced with a 200 h clock sends the final notice and pauses NOBODY in hour one", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row()],
        logged: [
          { milestone: "DUNNING_D0", sentAt: at(0) },
          { milestone: "DUNNING_D3", sentAt: at(72) },
          { milestone: "DUNNING_D6", sentAt: at(144) },
        ],
      });
      const out = await d.svc.sweep(at(200)); // 200 h = 08:00Z, past 03:00 UTC
      expect(sentMilestones(d)).toEqual([["DUNNING_FINAL", "in_1", "final"]]);
      expect(out.paused).toBe(0);
      expect(d.transition).not.toHaveBeenCalled();
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("no email is sent over an invoice Stripe shows paid or processing (M8 / N6)", async () => {
      mode("dark");
      const processing = make({
        sweepRows: [row()],
        facts: { ...OPEN_FACTS, paymentProcessing: true },
      });
      await processing.svc.sweep(at(80));
      expect(processing.notifications.notifyDunning).not.toHaveBeenCalled();
    });

    it("off mode and an unconfigured Stripe sweep nothing", async () => {
      mode("off");
      const a = make({ sweepRows: [row()] });
      await a.svc.sweep(at(200));
      expect(a.prisma.tenantSubscription.findMany).not.toHaveBeenCalled();
      mode("dark");
      const b = make({ sweepRows: [row()] });
      b.stripe.isConfigured = false;
      await b.svc.sweep(at(200));
      expect(b.prisma.tenantSubscription.findMany).not.toHaveBeenCalled();
    });

    it("the sweep selects only stamped Stripe-billed, non-manual rows with no catch-up claim", async () => {
      mode("dark");
      const d = make({ sweepRows: [] });
      await d.svc.sweep(at(1));
      expect(d.prisma.tenantSubscription.findMany.mock.calls[0][0].where).toEqual({
        pastDueInvoiceId: { not: null },
        stripeSubId: { not: null },
        externalPayment: false,
        catchupState: null,
        tenant: { deletedAt: null },
      });
    });

    it("skips a row whose catch-up claim is held even if one reaches it", async () => {
      mode("enforced");
      const d = make({ sweepRows: [row({ catchupState: "SESSION_OPEN" })] });
      await d.svc.sweep(at(400));
      expect(d.stripe.getInvoiceFacts).not.toHaveBeenCalled();
      expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
      expect(d.transition).not.toHaveBeenCalled();
    });

    it("one tenant's failure never stops the sweep", async () => {
      mode("dark");
      const d = make({ sweepRows: [row({ tenantId: "t1" }), row({ tenantId: "t2" })] });
      d.stripe.getInvoiceFacts
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(OPEN_FACTS);
      const out = await d.svc.sweep(at(1));
      expect(out).toMatchObject({ swept: 2, failed: 1 });
    });
  });

  // ─── the pause ────────────────────────────────────────────────────────────

  describe("the pause (enforced)", () => {
    const since = new Date("2026-11-01T00:00:00Z");
    const sentAt = (d: Date) => ({ sentAt: d });
    /** 2026-11-08 09:00Z: +177 h, and 09:00 UTC / 03:00 CST local. */
    const NOW = new Date("2026-11-08T09:00:00Z");
    const fullLog = (finalAt: Date | null) => [
      { milestone: "DUNNING_D0", ...sentAt(since) },
      { milestone: "DUNNING_D3", ...sentAt(new Date(since.getTime() + 72 * 3_600_000)) },
      { milestone: "DUNNING_D6", ...sentAt(new Date(since.getTime() + 144 * 3_600_000)) },
      ...(finalAt ? [{ milestone: "DUNNING_FINAL", sentAt: finalAt }] : []),
    ];
    const hoursBefore = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

    it("pauses at +168 h with dunning_final >= 24 h old, at 03:00 local: READ_ONLY(payment_overdue), -MRR once, then pause_collection AFTER commit", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
        tz: "America/Chicago",
      });
      const out = await d.svc.sweep(NOW);
      expect(out.paused).toBe(1);

      // the CAS on the subscription row
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", pausedAt: null, pastDueInvoiceId: "in_1", catchupState: null },
        data: { pausedAt: NOW },
      });
      // MRR through the one transition helper: ACTIVE -> READ_ONLY, -1, joined to the same tx
      expect(d.transition).toHaveBeenCalledTimes(1);
      const args = d.transition.mock.calls[0];
      expect(args.slice(0, 5)).toEqual([
        "t1",
        { status: "ACTIVE" },
        "READ_ONLY",
        -1,
        BILLING_EVENTS.SUBSCRIPTION_SUSPENDED,
      ]);
      expect(args[6]).toEqual({ tx: d.tx, data: { readOnlyReason: "payment_overdue" } });
      // pause_collection: set AFTER the local commit, key (tenant, "pause", pausedAt ISO)
      expect(d.stripe.updateSubscription).toHaveBeenCalledWith(
        "sub_1",
        { pause_collection: { behavior: "void" } },
        { idempotencyKey: `t1:pause:${NOW.toISOString()}` },
      );
      expect(d.order.indexOf("commit")).toBeGreaterThan(-1);
      expect(d.order.indexOf("stripe")).toBeGreaterThan(d.order.indexOf("commit"));
      expect(d.guard.invalidate).toHaveBeenCalledWith("t1");
      expect(d.notifications.notifyDunning).toHaveBeenCalledWith(
        "t1",
        "DUNNING_PAUSED",
        "in_1",
        "paused",
        expect.anything(),
      );
    });

    it("takes the Tenant lock before the subscription CAS", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
      });
      await d.svc.sweep(NOW);
      const lock = d.tx.$queryRaw.mock.invocationCallOrder[0];
      const cas = d.tx.tenantSubscription.updateMany.mock.invocationCallOrder[0];
      expect(lock).toBeLessThan(cas);
    });

    it("02:59 tenant-local does not pause; 03:00 does (America/Chicago, CST)", async () => {
      mode("enforced");
      const early = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(30)),
        tz: "America/Chicago",
      });
      const out1 = await early.svc.sweep(new Date("2026-11-08T08:59:00Z")); // 02:59 CST
      expect(out1.paused).toBe(0);
      expect(early.transition).not.toHaveBeenCalled();

      const on = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(new Date("2026-11-07T00:00:00Z")),
        tz: "America/Chicago",
      });
      const out2 = await on.svc.sweep(new Date("2026-11-08T09:00:00Z")); // 03:00 CST
      expect(out2.paused).toBe(1);
    });

    it("the 03:00 rule follows daylight time (America/Chicago CDT before the fall-back)", async () => {
      mode("enforced");
      const s = new Date("2026-10-20T00:00:00Z");
      const sweepRow = row({ pastDueSince: s });
      const logged = [
        { milestone: "DUNNING_D0", sentAt: s },
        { milestone: "DUNNING_D3", sentAt: new Date("2026-10-23T00:00:00Z") },
        { milestone: "DUNNING_D6", sentAt: new Date("2026-10-26T00:00:00Z") },
        { milestone: "DUNNING_FINAL", sentAt: new Date("2026-10-26T00:00:00Z") },
      ];
      // +168 h = 2026-10-27 00:00Z. CDT is UTC-5: 07:59Z = 02:59 local, 08:00Z = 03:00 local.
      const a = make({ sweepRows: [sweepRow], logged, tz: "America/Chicago" });
      expect((await a.svc.sweep(new Date("2026-10-27T07:59:00Z"))).paused).toBe(0);
      const b = make({ sweepRows: [sweepRow], logged, tz: "America/Chicago" });
      expect((await b.svc.sweep(new Date("2026-10-27T08:00:00Z"))).paused).toBe(1);
    });

    it("never before +168 h", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: new Date(NOW.getTime() - 167 * 3_600_000) })],
        logged: fullLog(hoursBefore(60)),
      });
      expect((await d.svc.sweep(NOW)).paused).toBe(0);
    });

    it("never when dunning_final is under 24 h old, or was never sent", async () => {
      mode("enforced");
      const fresh = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(23)),
      });
      expect((await fresh.svc.sweep(NOW)).paused).toBe(0);
      const never = make({ sweepRows: [row({ pastDueSince: since })], logged: fullLog(null) });
      never.notifications.notifyDunning.mockResolvedValue({ status: "failed", recipients: 0 });
      expect((await never.svc.sweep(NOW)).paused).toBe(0);
      expect(never.transition).not.toHaveBeenCalled();
    });

    it("dark never changes a status, no matter how overdue (a would-pause log only)", async () => {
      mode("dark");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(100)),
      });
      const out = await d.svc.sweep(NOW);
      expect(out).toMatchObject({ paused: 0, wouldPause: 1 });
      expect(d.transition).not.toHaveBeenCalled();
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("the CAS loser (count 0: another sweep paused it, or invoice.paid resumed first) pauses nothing and calls no Stripe", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
        subCasCount: 0,
      });
      const out = await d.svc.sweep(NOW);
      expect(out.paused).toBe(0);
      expect(d.transition).not.toHaveBeenCalled();
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
      expect(d.notifications.notifyDunning).not.toHaveBeenCalledWith(
        "t1",
        "DUNNING_PAUSED",
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    });

    it("a lost status CAS after the subscription CAS rolls the whole transaction back: no Stripe call", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
        transitionResult: false,
      });
      const out = await d.svc.sweep(NOW);
      expect(out.paused).toBe(0);
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
      expect(d.order).not.toContain("commit"); // the tx threw -> rolled back
    });

    it("a tenant that is not ACTIVE under the lock is not paused", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
      });
      d.tx.tenant.findUnique.mockResolvedValue({ status: "TRIAL" });
      expect((await d.svc.sweep(NOW)).paused).toBe(0);
      expect(d.tx.tenantSubscription.updateMany).not.toHaveBeenCalled();
    });

    it("already paused rows are left alone", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [
          row({
            pastDueSince: since,
            pausedAt: hoursBefore(5),
            tenant: {
              status: "READ_ONLY",
              readOnlyReason: "payment_overdue",
              deletedAt: null,
              class: "PRODUCTION",
            },
          }),
        ],
        logged: fullLog(hoursBefore(30)),
      });
      expect((await d.svc.sweep(NOW)).paused).toBe(0);
      expect(d.transition).not.toHaveBeenCalled();
    });

    it("a payment still processing is never paused over", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
        facts: { ...OPEN_FACTS, paymentProcessing: true },
      });
      expect((await d.svc.sweep(NOW)).paused).toBe(0);
    });

    it("an invoice Stripe now shows paid is resolved (resumed) by the sweep, never paused over", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [
          row({
            pastDueSince: since,
            pausedAt: hoursBefore(5),
            tenant: {
              status: "READ_ONLY",
              readOnlyReason: "payment_overdue",
              deletedAt: null,
              class: "PRODUCTION",
            },
          }),
        ],
        facts: { ...OPEN_FACTS, status: "paid", amountPaid: 4900, amountRemaining: 0 },
        txTenant: { status: "READ_ONLY", readOnlyReason: "payment_overdue" },
        exit: { tenantId: "t1", stripeSubId: "sub_1", exitAt: NOW },
      });
      const out = await d.svc.sweep(NOW);
      expect(out.resolved).toBe(1);
      expect(d.transition.mock.calls[0][2]).toBe("ACTIVE");
      expect(d.stripe.updateSubscription).toHaveBeenCalledWith(
        "sub_1",
        { pause_collection: "" },
        { idempotencyKey: `t1:unpause:${NOW.toISOString()}` },
      );
    });

    it("a failed pause_collection call never undoes the local pause", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
      });
      d.stripe.updateSubscription.mockRejectedValue(new Error("stripe down"));
      const out = await d.svc.sweep(NOW);
      expect(out.paused).toBe(1);
      expect(out.failed).toBe(0);
    });
  });

  // ─── fold round: quiet logs, copy by mode, the flip sequence ─────────────

  describe("fold round (Opus review of 00801c8b3)", () => {
    const since = new Date("2026-11-01T00:00:00Z");
    const H = 3_600_000;

    it("dark: would_pause is logged ONCE per tenant and invoice, not hourly", async () => {
      mode("dark");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: [
          { milestone: "DUNNING_D0", sentAt: since },
          { milestone: "DUNNING_D3", sentAt: since },
          { milestone: "DUNNING_D6", sentAt: since },
        ],
      });
      const log = jest.spyOn((d.svc as any).logger, "log").mockImplementation(() => undefined);
      const t0 = new Date("2026-11-08T09:00:00Z");
      await d.svc.sweep(t0);
      await d.svc.sweep(new Date(t0.getTime() + H));
      await d.svc.sweep(new Date(t0.getTime() + 2 * H));
      const lines = log.mock.calls.filter((c: any[]) => /would_pause/.test(String(c[0])));
      expect(lines).toHaveLength(1);
    });

    it("enforced: a tenant with no deliverable admin gets ONE warn (and is never paused), not one per hour", async () => {
      mode("enforced");
      const d = make({ sweepRows: [row({ pastDueSince: since })] });
      d.notifications.notifyDunning.mockResolvedValue({ status: "no_recipients", recipients: 0 });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      const t0 = new Date("2026-11-08T09:00:00Z");
      await d.svc.sweep(t0);
      await d.svc.sweep(new Date(t0.getTime() + H));
      const lines = warn.mock.calls.filter((c: any[]) => /no_deliverable_admin/.test(String(c[0])));
      expect(lines).toHaveLength(1);
      expect(d.transition).not.toHaveBeenCalled();
    });

    it("the flip sequence: dark d6 -> enforced sends a SEPARATE final notice; no pause until +24 h AND the 03:00-local sweep", async () => {
      // America/Chicago, CST (UTC-6) from Nov 1 2026
      const log: { milestone: string; sentAt: Date }[] = [];
      const base = make({ sweepRows: [row({ pastDueSince: since })], tz: "America/Chicago" });
      const d = base;
      d.prisma.billingNotificationLog.findMany.mockImplementation(async () => [...log]);
      let clock = new Date();
      d.notifications.notifyDunning.mockImplementation(
        async (_t: string, milestone: string, _i: string, kind: string) => {
          log.push({ milestone, sentAt: clock });
          sentKinds.push([milestone, kind]);
          return { status: "sent", recipients: 1 };
        },
      );
      d.notifications.recordDunningMilestone.mockImplementation(async (_t: string, m: string) => {
        log.push({ milestone: m, sentAt: clock });
        return true;
      });
      const sentKinds: [string, string][] = [];
      const sweepAt = async (iso: string) => {
        clock = new Date(iso);
        return d.svc.sweep(clock);
      };

      // days 0-6 in DARK: d0, d3, d6 go out; the d6 copy names no read-only date
      mode("dark");
      await sweepAt("2026-11-07T20:00:00Z"); // +164 h
      expect(sentKinds.map((k) => k[1])).toEqual(["d0", "d3", "d6"]);
      expect(sentKinds.map((k) => k[0])).not.toContain("DUNNING_FINAL");

      // the owner flips to ENFORCED at 2026-11-08 21:00Z (15:00 local): a separate final notice, NO pause now
      mode("enforced");
      const flip = await sweepAt("2026-11-08T21:00:00Z");
      expect(sentKinds.at(-1)).toEqual(["DUNNING_FINAL", "final"]);
      expect(flip.paused).toBe(0);

      // +23 h (20:00Z next day, 14:00 local): still no pause
      expect((await sweepAt("2026-11-09T20:00:00Z")).paused).toBe(0);
      // +24 h exactly but 02:00 local the NEXT day is later still; first check +27 h = 2026-11-09T24:00 = 18:00 local: pause allowed?
      // the final notice is >= 24 h old at 2026-11-09T21:00Z (15:00 local, hour >= 3): pause.
      const out = await sweepAt("2026-11-09T21:00:00Z");
      expect(out.paused).toBe(1);
    });

    it("the flip sequence honours 03:00 local: >= 24 h after the final notice but 02:59 local -> no pause; 03:00 -> pause", async () => {
      const log = [
        { milestone: "DUNNING_D0", sentAt: since },
        { milestone: "DUNNING_D3", sentAt: since },
        { milestone: "DUNNING_D6", sentAt: since },
        { milestone: "DUNNING_FINAL", sentAt: new Date("2026-11-07T07:00:00Z") },
      ];
      mode("enforced");
      const early = make({
        sweepRows: [row({ pastDueSince: since })],
        tz: "America/Chicago",
        logged: log,
      });
      // 2026-11-08T08:59Z = 02:59 CST (>= 24 h after the final notice)
      expect((await early.svc.sweep(new Date("2026-11-08T08:59:00Z"))).paused).toBe(0);
      const on = make({
        sweepRows: [row({ pastDueSince: since })],
        tz: "America/Chicago",
        logged: log,
      });
      expect((await on.svc.sweep(new Date("2026-11-08T09:00:00Z"))).paused).toBe(1);
    });
  });

  // ─── invoice.paid ─────────────────────────────────────────────────────────

  describe("invoice.paid: resume, or move the clock", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const PAUSED = { status: "READ_ONLY", readOnlyReason: "payment_overdue" };
    const pausedRow = (o: Record<string, unknown> = {}) =>
      row({
        pausedAt: new Date("2026-11-08T09:00:00Z"),
        tenant: {
          status: "READ_ONLY",
          readOnlyReason: "payment_overdue",
          deletedAt: null,
          class: "PRODUCTION",
        },
        ...o,
      });

    it("paying the clock invoice resumes: ACTIVE with +MRR once, the clock cleared, pause_collection cleared after", async () => {
      mode("enforced");
      const exit = { tenantId: "t1", stripeSubId: "sub_1", exitAt: now };
      const d = make({ row: pausedRow(), exit, txTenant: PAUSED });
      expect(await d.svc.onInvoicePaid(invoice(), now)).toBe("resumed");
      expect(d.transition).toHaveBeenCalledTimes(1);
      const a = d.transition.mock.calls[0];
      expect(a[0]).toBe("t1");
      // the decision is taken UNDER the Tenant lock, in the same transaction as the resume (joined `tx`)
      expect(a[1]).toEqual({ status: "READ_ONLY", readOnlyReason: "payment_overdue" });
      expect(a.slice(2, 5)).toEqual(["ACTIVE", 1, BILLING_EVENTS.SUBSCRIPTION_RESUMED]);
      expect(a[6]).toEqual({ tx: d.tx, onExit: expect.any(Function) });
      expect(d.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        d.tx.tenant.findUnique.mock.invocationCallOrder[0],
      );
      expect(d.stripe.updateSubscription).toHaveBeenCalledWith(
        "sub_1",
        { pause_collection: "" },
        { idempotencyKey: `t1:unpause:${now.toISOString()}` },
      );
      expect(d.order.indexOf("stripe")).toBeGreaterThan(d.order.indexOf("transition"));
      expect(d.guard.invalidate).toHaveBeenCalledWith("t1");
      // free until the next 1st: no stub invoice is created
      expect(Object.keys(d.stripe)).not.toContain("createInvoice");
    });

    it("a Stripe error clearing pause_collection throws so the webhook is redelivered (r4 F4 #6)", async () => {
      mode("enforced");
      const d = make({
        row: pausedRow(),
        exit: { tenantId: "t1", stripeSubId: "sub_1", exitAt: now },
        txTenant: PAUSED,
      });
      d.stripe.updateSubscription.mockRejectedValue(new Error("stripe down"));
      await expect(d.svc.onInvoicePaid(invoice(), now)).rejects.toThrow("stripe down");
    });

    it("paying a DIFFERENT invoice moves the clock to the oldest open one and leaves the tenant paused", async () => {
      mode("enforced");
      const d = make({
        row: pausedRow({ pastDueInvoiceId: "in_2" }),
        openInvoices: [
          { id: "in_0", amount_remaining: 4900, created: 1_700_000_000, status_transitions: {} },
          { id: "in_2", amount_remaining: 4900, created: 1_700_100_000 },
        ],
      });
      expect(await d.svc.onInvoicePaid(invoice({ id: "in_1" }), now)).toBe("moved");
      expect(d.transition).not.toHaveBeenCalled(); // still paused, no MRR
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", pastDueInvoiceId: "in_2" },
        data: { pastDueInvoiceId: "in_0", pastDueSince: new Date(1_700_000_000 * 1000) },
      });
    });

    it("paying the clock invoice while ANOTHER is still open moves the clock instead of resuming (M2)", async () => {
      mode("enforced");
      const d = make({
        row: pausedRow(),
        openInvoices: [{ id: "in_3", amount_remaining: 4900, created: 1_700_200_000 }],
      });
      expect(await d.svc.onInvoicePaid(invoice(), now)).toBe("moved");
      expect(d.transition).not.toHaveBeenCalled();
      expect(d.tx.tenantSubscription.updateMany.mock.calls[0][0].data.pastDueInvoiceId).toBe(
        "in_3",
      );
    });

    it("an invoice that is already the oldest open one changes nothing", async () => {
      mode("enforced");
      const d = make({
        row: pausedRow({ pastDueInvoiceId: "in_2" }),
        openInvoices: [{ id: "in_2", amount_remaining: 4900, created: 1_700_100_000 }],
      });
      expect(await d.svc.onInvoicePaid(invoice({ id: "in_1" }), now)).toBe("unchanged");
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("a cancelled paused tenant (READ_ONLY subscription_cancelled) stays cancelled: only the marker clears, no MRR", async () => {
      mode("enforced");
      const d = make({
        row: pausedRow({
          stripeSubId: null,
          pausedAt: null,
          tenant: {
            status: "READ_ONLY",
            readOnlyReason: "subscription_cancelled",
            deletedAt: null,
            class: "PRODUCTION",
          },
        }),
        txTenant: { status: "READ_ONLY", readOnlyReason: "subscription_cancelled" },
      });
      // found by the owed marker alone: its stripeSubId was cleared by the cancel
      expect(await d.svc.onInvoicePaid(invoice(), now)).toBe("cleared");
      expect(d.prisma.tenantSubscription.findFirst.mock.calls[0][0].where).toEqual({
        OR: [{ stripeSubId: "sub_1" }, { pastDueInvoiceId: "in_1" }],
      });
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", pastDueInvoiceId: "in_1" },
        data: { pastDueSince: null, pastDueInvoiceId: null, pausedAt: null },
      });
    });

    it("dark (an ACTIVE tenant with a clock): paying clears the clock and changes no status", async () => {
      mode("dark");
      const d = make({ row: row() }); // the locked re-read says ACTIVE
      expect(await d.svc.onInvoicePaid(invoice(), now)).toBe("cleared");
      expect(d.transition).not.toHaveBeenCalled();
    });

    it("an unreadable Stripe throws before any local write", async () => {
      mode("enforced");
      const d = make({ row: pausedRow() });
      d.stripe.listOwedSubscriptionInvoices.mockRejectedValue(new Error("stripe down"));
      await expect(d.svc.onInvoicePaid(invoice(), now)).rejects.toThrow("stripe down");
      expect(d.transition).not.toHaveBeenCalled();
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
    });

    it("every delivery heals a stale Stripe pause when local pausedAt is null (a CAS loser too)", async () => {
      mode("enforced");
      // the winner already resumed (no marker left); its post-commit unpause was lost
      const d = make({
        row: row({ pastDueInvoiceId: null }),
        stripeSub: { status: "active", pause_collection: { behavior: "void" } },
        localPausedAt: null,
      });
      await d.svc.onInvoicePaid(invoice(), now);
      expect(d.stripe.updateSubscription).toHaveBeenCalledWith(
        "sub_1",
        { pause_collection: "" },
        { idempotencyKey: `t1:unpause:${now.toISOString()}` },
      );
    });

    it("...but leaves Stripe's pause alone while the tenant is locally paused", async () => {
      mode("enforced");
      const d = make({
        row: row({ pastDueInvoiceId: null }),
        stripeSub: { status: "active", pause_collection: { behavior: "void" } },
        localPausedAt: new Date("2026-11-08T09:00:00Z"),
      });
      await d.svc.onInvoicePaid(invoice(), now);
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("an UNCOLLECTIBLE sibling is still owed: paying the clock invoice moves the clock instead of resuming", async () => {
      mode("enforced");
      const d = make({
        row: pausedRow(),
        txTenant: PAUSED,
        openInvoices: [
          { id: "in_9", status: "uncollectible", amount_remaining: 4900, created: 1_700_300_000 },
        ],
      });
      expect(await d.svc.onInvoicePaid(invoice(), now)).toBe("moved");
      expect(d.transition).not.toHaveBeenCalled();
      expect(d.stripe.listOwedSubscriptionInvoices).toHaveBeenCalledWith("sub_1");
    });

    it("dark: the stale-pause heal only LOGS the would-unpause (it must not remove a hand-set dashboard pause)", async () => {
      mode("dark");
      const d = make({
        row: row({ pastDueInvoiceId: null }),
        stripeSub: { status: "active", pause_collection: { behavior: "void" } },
        localPausedAt: null,
      });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      await d.svc.onInvoicePaid(invoice(), now);
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
      expect(
        warn.mock.calls.some((c: any[]) => /would_unpause tenant=t1 sub=sub_1/.test(String(c[0]))),
      ).toBe(true);
    });

    it("off: the heal does not even read Stripe", async () => {
      mode("off");
      const d = make({ row: row({ pastDueInvoiceId: null }) });
      await d.svc.onInvoicePaid(invoice(), now);
      expect(d.stripe.getSubscription).not.toHaveBeenCalled();
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("a healthy tenant's ordinary renewal invoice.paid touches nothing", async () => {
      mode("enforced");
      const d = make({ row: row({ pastDueInvoiceId: null }) });
      expect(await d.svc.onInvoicePaid(invoice(), now)).toBe("unchanged");
      expect(d.transition).not.toHaveBeenCalled();
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("an invoice matching no row is ignored", async () => {
      const d = make({ row: null });
      expect(await d.svc.onInvoicePaid(invoice(), now)).toBe("ignored");
    });
  });

  // ─── cancel while paused / exits ──────────────────────────────────────────

  describe("cancel while paused", () => {
    it("lands on READ_ONLY(subscription_cancelled), clears local pausedAt only, keeps the owed marker", async () => {
      const d = make();
      expect(await d.svc.markCancelledWhilePaused("t1")).toBe(true);
      expect(d.tx.tenant.updateMany).toHaveBeenCalledWith({
        where: { id: "t1", status: "READ_ONLY", readOnlyReason: "payment_overdue" },
        data: { readOnlyReason: "subscription_cancelled" },
      });
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1" },
        data: { pausedAt: null },
      });
      expect(d.guard.invalidate).toHaveBeenCalledWith("t1");
      expect(d.transition).not.toHaveBeenCalled(); // never CANCELLED, no MRR
    });

    it("is a no-op for any tenant that is not paused", async () => {
      const d = make();
      d.tx.tenant.updateMany.mockResolvedValue({ count: 0 });
      expect(await d.svc.markCancelledWhilePaused("t1")).toBe(false);
      expect(d.tx.tenantSubscription.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("clearPauseAfterCommit", () => {
    const exit = { tenantId: "t1", stripeSubId: "sub_1", exitAt: new Date("2026-11-09T12:00:00Z") };

    it("clears pause_collection with the (tenant, unpause, exitAt) key", async () => {
      const d = make();
      await d.svc.clearPauseAfterCommit(exit);
      expect(d.stripe.updateSubscription).toHaveBeenCalledWith(
        "sub_1",
        { pause_collection: "" },
        { idempotencyKey: "t1:unpause:2026-11-09T12:00:00.000Z" },
      );
    });

    it("null exit = nothing was paused = no Stripe call", async () => {
      const d = make();
      await d.svc.clearPauseAfterCommit(null);
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("a Stripe error is logged, not thrown, for an admin path; thrown when asked (webhooks)", async () => {
      const d = make();
      d.stripe.updateSubscription.mockRejectedValue(new Error("stripe down"));
      await expect(d.svc.clearPauseAfterCommit(exit)).resolves.toBeUndefined();
      await expect(d.svc.clearPauseAfterCommit(exit, { throwOnError: true })).rejects.toThrow();
    });

    it("a subscription Stripe no longer knows is not an error", async () => {
      const d = make();
      d.stripe.updateSubscription.mockRejectedValue({ code: "resource_missing" });
      await expect(
        d.svc.clearPauseAfterCommit(exit, { throwOnError: true }),
      ).resolves.toBeUndefined();
    });
  });

  // ─── the reconciler ───────────────────────────────────────────────────────

  describe("the pause_collection reconciler", () => {
    const runAt = new Date("2026-11-10T10:00:00Z");
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        tenantId: `t${i + 1}`,
        stripeSubId: `sub_${i + 1}`,
      }));
    const subs = (n = 1) => ({ sweepRows: ids(n) });

    it("local paused + Stripe not paused: sets pause_collection, key (tenant, reconcile, runAt), under the Tenant lock", async () => {
      mode("enforced");
      const d = make({
        ...subs(),
        stripeSub: { status: "active" },
        localPausedAt: new Date("2026-11-08T09:00:00Z"),
      });
      const out = await d.svc.reconcile(runAt);
      expect(out).toEqual({ checked: 1, corrected: 1, failed: 0 });
      expect(d.stripe.updateSubscription).toHaveBeenCalledWith(
        "sub_1",
        { pause_collection: { behavior: "void" } },
        { idempotencyKey: `t1:reconcile:${runAt.toISOString()}` },
      );
      // Stripe is read FIRST, then local under the lock, and the correction is made while holding it
      expect(d.stripe.getSubscription.mock.invocationCallOrder[0]).toBeLessThan(
        d.tx.$queryRaw.mock.invocationCallOrder[0],
      );
      expect(d.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        d.stripe.updateSubscription.mock.invocationCallOrder[0],
      );
      expect(d.order.indexOf("stripe")).toBeLessThan(d.order.indexOf("commit"));
    });

    it("enforced, local not paused + Stripe paused: clears it", async () => {
      mode("enforced");
      const d = make({
        ...subs(),
        stripeSub: { status: "active", pause_collection: { behavior: "void" } },
        localPausedAt: null,
      });
      expect((await d.svc.reconcile(runAt)).corrected).toBe(1);
      expect(d.stripe.updateSubscription.mock.calls[0][1]).toEqual({ pause_collection: "" });
    });

    it.each(["off", "dark"])(
      "%s: NEVER writes in the unpause direction (a hand-set dashboard pause survives the first deploy); it LOGS the would-unpause",
      async (m) => {
        mode(m);
        const d = make({
          ...subs(),
          stripeSub: { status: "active", pause_collection: { behavior: "void" } },
          localPausedAt: null,
        });
        const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
        const out = await d.svc.reconcile(runAt);
        expect(out.corrected).toBe(0);
        expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
        expect(
          warn.mock.calls.some((c: any[]) =>
            /would_unpause tenant=t1 sub=sub_1/.test(String(c[0])),
          ),
        ).toBe(true);
      },
    );

    it.each(["off", "dark"])(
      "%s: still sets pause_collection for a tenant that IS locally paused (set direction is safe)",
      async (m) => {
        mode(m);
        const d = make({
          ...subs(),
          stripeSub: { status: "active" },
          localPausedAt: new Date("2026-11-08T09:00:00Z"),
        });
        expect((await d.svc.reconcile(runAt)).corrected).toBe(1);
      },
    );

    it("agreement makes no Stripe write", async () => {
      mode("enforced");
      const both = make({
        ...subs(),
        stripeSub: { status: "active", pause_collection: { behavior: "void" } },
        localPausedAt: new Date("2026-11-08T09:00:00Z"),
      });
      expect((await both.svc.reconcile(runAt)).corrected).toBe(0);
      const neither = make({ ...subs(), stripeSub: { status: "active" }, localPausedAt: null });
      expect((await neither.svc.reconcile(runAt)).corrected).toBe(0);
      expect(both.stripe.updateSubscription).not.toHaveBeenCalled();
      expect(neither.stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("a canceled Stripe subscription is out of scope", async () => {
      mode("enforced");
      const d = make({ ...subs(), stripeSub: { status: "canceled" }, localPausedAt: new Date() });
      const out = await d.svc.reconcile(runAt);
      expect(out.checked).toBe(0);
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("selects Stripe-billed, non-manual rows only", async () => {
      const d = make({ sweepRows: [] });
      await d.svc.reconcile(runAt);
      expect(d.prisma.tenantSubscription.count.mock.calls[0][0].where).toEqual({
        stripeSubId: { not: null },
        externalPayment: false,
        tenant: { deletedAt: null },
      });
    });

    it("one tenant's Stripe error is counted and the run continues", async () => {
      mode("enforced");
      const d = make({ ...subs(2), stripeSub: { status: "active" }, localPausedAt: null });
      d.stripe.getSubscription.mockRejectedValueOnce(new Error("boom"));
      const out = await d.svc.reconcile(runAt);
      expect(out).toMatchObject({ failed: 1, checked: 1 });
    });

    it("does nothing when Stripe is not configured", async () => {
      const d = make(subs());
      d.stripe.isConfigured = false;
      expect(await d.svc.reconcile(runAt)).toEqual({ checked: 0, corrected: 0, failed: 0 });
    });

    describe("pagination: a keyset cursor over the WHOLE population, rotating when over budget", () => {
      const reached = (d: ReturnType<typeof make>) =>
        d.stripe.getSubscription.mock.calls.map((c: any[]) => c[0] as string);

      it("reads the population in bounded keyset batches until exhausted", async () => {
        const d = make({ ...subs(5), stripeSub: { status: "active" } });
        const out = await d.svc.reconcile(runAt, { maxRows: 100, batchSize: 2 });
        expect(out.checked).toBe(5);
        expect(reached(d)).toEqual(["sub_1", "sub_2", "sub_3", "sub_4", "sub_5"]);
        // 3 batches (2+2+1) plus the empty check is NOT needed: each batch is a keyset page
        const pages = d.prisma.tenantSubscription.findMany.mock.calls.map((c: any[]) => c[0]);
        expect(pages.every((p: any) => p.take <= 2)).toBe(true);
        expect(pages.length).toBeGreaterThanOrEqual(3);
        expect(pages[1].where.tenantId).toEqual({ gt: "t2" });
      });

      it("over budget: consecutive hourly runs rotate so EVERY row is reached across runs", async () => {
        const seen = new Set<string>();
        for (let h = 0; h < 3; h++) {
          const d = make({ ...subs(5), stripeSub: { status: "active" } });
          const at = new Date(runAt.getTime() + h * 3_600_000);
          const out = await d.svc.reconcile(at, { maxRows: 2, batchSize: 2 });
          expect(out.checked).toBe(2); // the row budget caps one run
          for (const id of reached(d)) seen.add(id);
        }
        expect([...seen].sort()).toEqual(["sub_1", "sub_2", "sub_3", "sub_4", "sub_5"]);
      });

      it("the rotation wraps past the end of the keyset", async () => {
        // pick an hour whose start offset lands on the last row: the run continues from the beginning
        const total = 5;
        const budget = 2;
        let hit: Set<string> | null = null;
        for (let h = 0; h < 6 && !hit; h++) {
          const d = make({ ...subs(total), stripeSub: { status: "active" } });
          await d.svc.reconcile(new Date(runAt.getTime() + h * 3_600_000), {
            maxRows: budget,
            batchSize: 2,
          });
          const ids2 = reached(d);
          if (ids2.includes("sub_5") && ids2.includes("sub_1")) hit = new Set(ids2);
        }
        expect(hit).not.toBeNull();
      });
    });
  });
});
