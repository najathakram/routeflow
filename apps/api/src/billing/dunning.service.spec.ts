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
  invoiceNumber: "INV-0042",
  currency: "usd",
};

/** The notice key of an episode: `<invoiceId>:<pastDueSince ISO>` (SA r-note 3). */
const ep = (since: Date, invoiceId = "in_1") => `${invoiceId}:${since.toISOString()}`;
/** The default row's episode (pastDueSince 2026-11-01T00:00Z). */
const EP = ep(new Date("2026-11-01T00:00:00Z"));

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
    /** SA-775: the rollout switch handed to the service (absent = a bare unit spec, as today). */
    autoLocks?: { isPaused(): Promise<boolean> };
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
    // the log is keyed per EPISODE (`<invoiceId>:<pastDueSince ISO>`): the fake only returns rows for the key asked
    billingNotificationLog: {
      findMany: jest.fn(async (a: any) =>
        (opts.logged ?? [])
          .filter((l: any) => (l.key ?? EP) === a?.where?.key)
          .filter(
            (l: any) => !a?.where?.milestone?.in || a.where.milestone.in.includes(l.milestone),
          ),
      ),
    },
    $transaction: jest.fn(async (fn: any) => {
      const r = await fn(tx);
      order.push("commit");
      return r;
    }),
  };
  const stripe: any = {
    isConfigured: true,
    getInvoiceFacts: jest.fn().mockResolvedValue(opts.facts ?? OPEN_FACTS),
    listOpenSubscriptionInvoices: jest.fn().mockResolvedValue(opts.openInvoices ?? []),
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
  const svc = new DunningService(prisma, stripe, notifications, guard, opts.autoLocks as any);
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

    it("stamps pastDueSince + pastDueInvoiceId, then (enforced) sends the d0 notice in place of the direct failed-payment email", async () => {
      mode("enforced");
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
        ep(now),
        "d0",
        expect.objectContaining({ payUrl: "https://pay.example.test/i/in_1" }),
      );
      expect(d.transition).not.toHaveBeenCalled(); // a stamp never changes a status
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

    // SA r-note 3 (supersedes r-note 2's keep-original clause): a re-stamp after an exit is a NEW episode
    it("(ii) a webhook re-stamp after an exit: pastDueSince = the stamp time, d0 goes out AGAIN under the new episode key", async () => {
      mode("enforced");
      const oldEpisode = new Date("2026-10-20T00:00:00Z");
      const d = make({
        row: row({ pastDueInvoiceId: null, pastDueSince: null }),
        // the previous episode's rows are still there (audit): d0, d3, final and PAUSED under the OLD key
        logged: ["DUNNING_D0", "DUNNING_D3", "DUNNING_FINAL", "DUNNING_PAUSED"].map((m) => ({
          milestone: m,
          sentAt: oldEpisode,
          key: ep(oldEpisode),
        })),
      });
      expect(await d.svc.onPaymentFailed(invoice(), now)).toBe("stamped");
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", pastDueInvoiceId: null, catchupState: null },
        data: { pastDueSince: now, pastDueInvoiceId: "in_1" },
      });
      expect(d.notifications.notifyDunning).toHaveBeenCalledWith(
        "t1",
        "DUNNING_D0",
        ep(now),
        "d0",
        expect.anything(),
      );
    });

    it("the lookup of already-sent milestones is by the CURRENT episode key", async () => {
      mode("enforced");
      const d = make({ row: row({ pastDueInvoiceId: null, pastDueSince: null }) });
      await d.svc.onPaymentFailed(invoice(), now);
      expect(d.prisma.billingNotificationLog.findMany.mock.calls[0][0].where).toMatchObject({
        tenantId: "t1",
        key: ep(now),
      });
    });

    it("logs the clock start once, with the finalization time and the first failure (for the blast-radius report)", async () => {
      mode("dark");
      const d = make({ row: row({ pastDueInvoiceId: null, pastDueSince: null }) });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      await d.svc.onPaymentFailed(
        invoice({ status_transitions: { finalized_at: 1_700_000_000 } }),
        now,
      );
      const line = String(
        warn.mock.calls.map((c: any[]) => c[0]).find((l: string) => /clock_started/.test(l)),
      );
      expect(line).toContain("tenant=t1");
      expect(line).toContain("invoice=in_1");
      expect(line).toContain(`stampAt=${now.toISOString()}`);
      expect(line).toContain(`firstFailureAt=${now.toISOString()}`);
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
      mode("enforced");
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
      mode("enforced");
      const d = make({ sweepRows: [row()] });
      await d.svc.sweep(at(1));
      expect(sentMilestones(d)).toEqual([["DUNNING_D0", EP, "d0"]]);
    });

    it("at +80 h d0 and d3 are both due, so ONLY d3 is sent; d0 is recorded as skipped so it never sends later", async () => {
      mode("enforced");
      const d = make({ sweepRows: [row()] });
      await d.svc.sweep(at(80));
      expect(sentMilestones(d)).toEqual([["DUNNING_D3", EP, "d3"]]);
      expect(d.notifications.recordDunningMilestone).toHaveBeenCalledWith("t1", "DUNNING_D0", EP);
    });

    // deploy day (Opus re-review): a clock that keeps an OLD finalization time (discovery, a moved clock) must not
    // mail d0 + d3 + d6 in one sweep - only the highest milestone due goes out
    it("deploy day, enforced, 200 h clock and nothing logged: ONE email (the final notice); d0/d3 skipped, dunning_final recorded", async () => {
      mode("enforced");
      const d = make({ sweepRows: [row()] });
      const out = await d.svc.sweep(at(200));
      expect(sentMilestones(d)).toEqual([["DUNNING_D6", EP, "final"]]);
      const recorded = d.notifications.recordDunningMilestone.mock.calls
        .map((c: any[]) => c[1])
        .sort();
      expect(recorded).toEqual(["DUNNING_D0", "DUNNING_D3", "DUNNING_FINAL"]);
      expect(out.paused).toBe(0); // the 24 h lead still starts now
    });

    it("an already-logged milestone is never re-sent (the sweep is hourly)", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row()],
        logged: [
          { milestone: "DUNNING_D0", sentAt: at(0) },
          { milestone: "DUNNING_D3", sentAt: at(72) },
          { milestone: "DUNNING_D6", sentAt: at(144) },
          { milestone: "DUNNING_FINAL", sentAt: at(144) },
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
        EP,
        "final",
        expect.objectContaining({ readOnlyOn: "Nov 9, 2026" }),
      );
      expect(d.notifications.recordDunningMilestone).toHaveBeenCalledWith(
        "t1",
        "DUNNING_FINAL",
        EP,
      );
      expect(d.transition).not.toHaveBeenCalled();
    });

    describe("SA-775: the final notice drops the lock threat when the pause holds the lock", () => {
      const finalExtra = (d: any) =>
        d.notifications.notifyDunning.mock.calls.find((c: any[]) => c[3] === "final")?.[4];
      const sweepFinal = async (cls: string, autoLocks?: { isPaused(): Promise<boolean> }) => {
        mode("enforced");
        const d = make({
          sweepRows: [row({ tenant: { ...row().tenant, class: cls } })],
          logged: [
            { milestone: "DUNNING_D0", sentAt: at(0) },
            { milestone: "DUNNING_D3", sentAt: at(72) },
          ],
          autoLocks,
        });
        await d.svc.sweep(at(150));
        return d;
      };

      // A mutable log + switch so a second sweep sees what the first one sent (the mocks do not persist by themselves).
      const lifecycle = (cls = "PRODUCTION") => {
        mode("enforced");
        const sw = { paused: true };
        const logged: { milestone: string; sentAt: Date; key?: string }[] = [
          { milestone: "DUNNING_D0", sentAt: at(0) },
          { milestone: "DUNNING_D3", sentAt: at(72) },
        ];
        let clock = at(150);
        const d = make({
          sweepRows: [row({ tenant: { ...row().tenant, class: cls } })],
          logged,
          autoLocks: { isPaused: async () => sw.paused },
          localPausedAt: at(177),
        });
        d.notifications.notifyDunning.mockImplementation(
          async (_t: string, milestone: string, key: string) => {
            logged.push({ milestone, sentAt: clock, key });
            return { status: "sent", recipients: 1 };
          },
        );
        d.notifications.recordDunningMilestone.mockImplementation(
          async (_t: string, milestone: string, key: string) => {
            logged.push({ milestone, sentAt: clock, key });
            return true;
          },
        );
        const sweepAt = (h: number) => {
          clock = at(h);
          return d.svc.sweep(clock);
        };
        return { d, sw, sweepAt };
      };
      const finals = (d: any) =>
        d.notifications.notifyDunning.mock.calls.filter((c: any[]) => c[3] === "final");

      it("held + PRODUCTION: the neutral notice goes out ONCE under D6; it is NOT the final notice (no DUNNING_FINAL)", async () => {
        const { d, sweepAt } = lifecycle();
        await sweepAt(150);
        expect(finals(d)).toHaveLength(1);
        expect(finals(d)[0].slice(0, 4)).toEqual(["t1", "DUNNING_D6", EP, "final"]);
        expect(finals(d)[0][4].omitLockWarning).toBe(true);
        expect(finals(d)[0][4].readOnlyOn).toBeUndefined();
        expect(d.notifications.recordDunningMilestone).not.toHaveBeenCalledWith(
          "t1",
          "DUNNING_FINAL",
          EP,
        );
        // the next hourly sweeps send nothing and pause nobody (the gate holds the lock)
        await sweepAt(151);
        await sweepAt(177);
        expect(finals(d)).toHaveLength(1);
        expect(d.transition).not.toHaveBeenCalled();
      });

      it("held, then unpaused: the REAL final (with its date) is sent once, and the pause waits 24 h after it", async () => {
        const { d, sw, sweepAt } = lifecycle();
        await sweepAt(150); // held: neutral notice only
        sw.paused = false; // a super admin unpauses
        await sweepAt(160);
        expect(finals(d)).toHaveLength(2);
        expect(finals(d)[1].slice(0, 4)).toEqual(["t1", "DUNNING_FINAL", EP, "final"]);
        expect(finals(d)[1][4]).toEqual(
          expect.objectContaining({ omitLockWarning: false, readOnlyOn: "Nov 9, 2026" }),
        );
        expect(d.transition).not.toHaveBeenCalled(); // never in the sweep that sent the notice
        await sweepAt(183); // 23 h after the real final
        expect(d.transition).not.toHaveBeenCalled();
        await sweepAt(185); // 25 h after it (09:00+ local)
        expect(d.transition).toHaveBeenCalledTimes(1);
        expect(finals(d)).toHaveLength(2); // sent once, never resent
      });

      it.each([
        ["TEST class", "TEST", { isPaused: async () => true }],
        ["switch not paused", "PRODUCTION", { isPaused: async () => false }],
        ["no switch injected", "PRODUCTION", undefined],
      ])("%s: not omitted (the unchanged copy)", async (_n, cls, sw) => {
        const d = await sweepFinal(cls as string, sw as any);
        expect(finalExtra(d).omitLockWarning).toBe(sw ? false : undefined);
        expect(finalExtra(d).readOnlyOn).toBe("Nov 9, 2026");
      });

      it("d0 / d3 emails carry no omitLockWarning", async () => {
        mode("enforced");
        const d = make({ sweepRows: [row()], autoLocks: { isPaused: async () => true } });
        await d.svc.sweep(at(80));
        expect(d.notifications.notifyDunning.mock.calls[0][4]).not.toHaveProperty(
          "omitLockWarning",
        );
      });
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
      expect(sentMilestones(d)).toEqual([["DUNNING_FINAL", EP, "final"]]);
      expect(out.paused).toBe(0);
      expect(d.transition).not.toHaveBeenCalled();
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("no email is sent over an invoice Stripe shows paid or processing (M8 / N6)", async () => {
      mode("enforced");
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
        localPausedAt: NOW, // the pause just stamped it: the post-commit set re-reads it under the Tenant lock
      });
      const out = await d.svc.sweep(NOW);
      expect(out.paused).toBe(1);

      // the CAS on the subscription row
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: {
          tenantId: "t1",
          pausedAt: null,
          pastDueInvoiceId: "in_1",
          pastDueSince: since,
          catchupState: null,
        },
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
        EP,
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
        { milestone: "DUNNING_D0", sentAt: s, key: ep(s) },
        { milestone: "DUNNING_D3", sentAt: new Date("2026-10-23T00:00:00Z"), key: ep(s) },
        { milestone: "DUNNING_D6", sentAt: new Date("2026-10-26T00:00:00Z"), key: ep(s) },
        { milestone: "DUNNING_FINAL", sentAt: new Date("2026-10-26T00:00:00Z"), key: ep(s) },
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
      expect(d.notifications.notifyDunning).not.toHaveBeenCalledWith(
        "t1",
        expect.stringMatching(/^DUNNING_(D0|D3|D6|FINAL)$/),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
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

    it("the clocked invoice voided / marked uncollectible while the tenant is PAUSED: the sweep does nothing (no new resume path)", async () => {
      mode("enforced");
      for (const status of ["void", "uncollectible"]) {
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
          facts: { ...OPEN_FACTS, status },
        });
        const out = await d.svc.sweep(NOW);
        expect(out.paused).toBe(0);
        expect(d.transition).not.toHaveBeenCalled();
        expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
      }
    });

    it("an uncollectible clocked invoice is never emailed over or paused over (the owner wrote it off)", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(30)),
        facts: { ...OPEN_FACTS, status: "uncollectible" },
      });
      const out = await d.svc.sweep(NOW);
      expect(out.paused).toBe(0);
      expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
      expect(d.transition).not.toHaveBeenCalled();
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

    it("the post-commit pause_collection set runs in a Tenant-lock tx and is SKIPPED when pausedAt was cleared meanwhile (a resume won)", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
        localPausedAt: null, // invoice.paid resumed between the pause commit and the set
      });
      const out = await d.svc.sweep(NOW);
      expect(out.paused).toBe(1);
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
      // ...and when it does run it is under the lock, before the Stripe call
      const kept = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
        localPausedAt: NOW,
      });
      await kept.svc.sweep(NOW);
      const locks = kept.tx.$queryRaw.mock.invocationCallOrder;
      expect(locks[locks.length - 1]).toBeLessThan(
        kept.stripe.updateSubscription.mock.invocationCallOrder[0],
      );
    });

    it("a pausedAt that is NOT the stamped one (re-paused since) is not overwritten either", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
        localPausedAt: new Date(NOW.getTime() + 3_600_000),
      });
      await d.svc.sweep(NOW);
      expect(d.stripe.updateSubscription).not.toHaveBeenCalled();
    });

    it("a failed pause_collection call never undoes the local pause", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        logged: fullLog(hoursBefore(25)),
        localPausedAt: NOW,
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

    it("dark: the would_pause once-key includes the EPISODE: a re-stamped clock on the same invoice logs again", async () => {
      mode("dark");
      const s1 = new Date("2026-11-01T00:00:00Z");
      const s2 = new Date("2026-11-03T00:00:00Z");
      const rows = [row({ pastDueSince: s1 })];
      const logged = [s1, s2].flatMap((s) =>
        ["DUNNING_D0", "DUNNING_D3", "DUNNING_D6"].map((m) => ({
          milestone: m,
          sentAt: s,
          key: ep(s),
        })),
      );
      const d = make({ sweepRows: rows, logged });
      const log = jest.spyOn((d.svc as any).logger, "log").mockImplementation(() => undefined);
      const t0 = new Date("2026-11-12T09:00:00Z");
      await d.svc.sweep(t0);
      await d.svc.sweep(new Date(t0.getTime() + H));
      rows[0] = row({ pastDueSince: s2 }); // exit + re-stamp of the SAME invoice
      await d.svc.sweep(new Date(t0.getTime() + 2 * H));
      await d.svc.sweep(new Date(t0.getTime() + 3 * H));
      expect(log.mock.calls.filter((c: any[]) => /would_pause/.test(String(c[0])))).toHaveLength(2);
    });

    it("a clocked row with no pastDueSince is a no-op with a warn (never `now`): no notice, no pause", async () => {
      mode("enforced");
      const d = make({ sweepRows: [row({ pastDueSince: null })] });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      const out = await d.svc.sweep(new Date("2026-11-12T09:00:00Z"));
      expect(out.paused).toBe(0);
      expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
      expect(d.transition).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toBe(
        "billing.dunning.clock_without_since tenant=t1 invoice=in_1",
      );
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

    it("the flip sequence: days 0-6 in DARK send nothing; the flip to enforced sends the final notice (d6) and pauses NOBODY in hour one; the pause follows >= 24 h later at 03:00+ local", async () => {
      // America/Chicago, CST (UTC-6) from Nov 1 2026
      const log: { milestone: string; sentAt: Date }[] = [];
      const d = make({ sweepRows: [row({ pastDueSince: since })], tz: "America/Chicago" });
      d.prisma.billingNotificationLog.findMany.mockImplementation(async () => [...log]);
      let clock = new Date();
      const sentKinds: [string, string][] = [];
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
      const sweepAt = async (iso: string) => {
        clock = new Date(iso);
        return d.svc.sweep(clock);
      };

      // days 0-6 in DARK: stamp and log only - no tenant email at all (A1)
      mode("dark");
      await sweepAt("2026-11-07T20:00:00Z"); // +164 h
      expect(sentKinds).toEqual([]);
      expect(log).toEqual([]);

      // the owner flips to ENFORCED at 2026-11-08 21:00Z (15:00 local): d6 IS the final notice, NO pause now
      mode("enforced");
      const flip = await sweepAt("2026-11-08T21:00:00Z");
      expect(sentKinds.at(-1)).toEqual(["DUNNING_D6", "final"]);
      expect(log.some((l) => l.milestone === "DUNNING_FINAL")).toBe(true);
      expect(flip.paused).toBe(0);

      // +23 h (20:00Z next day, 14:00 local): still no pause
      expect((await sweepAt("2026-11-09T20:00:00Z")).paused).toBe(0);
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

  // ─── SA r-note 3: a dunning EPISODE runs from a stamp to the next exit ─────────────────────────────

  describe("episodes: notices are keyed <invoiceId>:<pastDueSince ISO>", () => {
    const T1 = new Date("2026-11-10T04:00:00Z"); // 04:00 UTC: the pause hour is reached on every sweep
    const H = 3_600_000;
    const at = (h: number) => new Date(T1.getTime() + h * H);
    const OLD = new Date("2026-10-20T00:00:00Z");
    const oldEpisodeRows = [
      "DUNNING_D0",
      "DUNNING_D3",
      "DUNNING_D6",
      "DUNNING_FINAL",
      "DUNNING_PAUSED",
    ].map((m) => ({ milestone: m, sentAt: OLD, key: ep(OLD) }));

    /** A stateful notice log: the notification mocks append rows keyed exactly as the service passes them. */
    function world(initial: any[] = [], extra: Record<string, unknown> = {}) {
      const log: any[] = [...initial];
      let clock = T1;
      const d = make({
        sweepRows: [row({ pastDueSince: T1 })],
        tz: "UTC",
        localPausedAt: T1,
        ...extra,
      });
      d.prisma.billingNotificationLog.findMany.mockImplementation(async (a: any) =>
        log.filter(
          (l) =>
            l.key === a?.where?.key &&
            (!a.where.milestone?.in || a.where.milestone.in.includes(l.milestone)),
        ),
      );
      d.notifications.notifyDunning.mockImplementation(
        async (_t: string, m: string, key: string) => {
          log.push({ milestone: m, key, sentAt: clock });
          return { status: "sent", recipients: 1 };
        },
      );
      d.notifications.recordDunningMilestone.mockImplementation(
        async (_t: string, m: string, key: string) => {
          log.push({ milestone: m, key, sentAt: clock });
          return true;
        },
      );
      const sweepAt = (h: number) => {
        clock = at(h);
        return d.svc.sweep(clock);
      };
      return { d, log, sweepAt };
    }
    const sent = (d: ReturnType<typeof make>) =>
      d.notifications.notifyDunning.mock.calls.map((c: any[]) => [c[1], c[2], c[3]]);

    it("(i) after an exit the SAME invoice is re-stamped: d0 goes out again, the old FINAL cannot authorise a pause, no pause before +168 h, and the PAUSED notice is sent when it does pause", async () => {
      mode("enforced");
      const w = world(oldEpisodeRows); // episode 1 is history: d0, d3, d6, FINAL and PAUSED under the OLD key
      await w.sweepAt(1);
      expect(sent(w.d)).toEqual([["DUNNING_D0", ep(T1), "d0"]]); // fresh notice, not suppressed by the old rows

      await w.sweepAt(144); // d6 is due: it IS the final notice of THIS episode
      expect(sent(w.d).at(-1)).toEqual(["DUNNING_D6", ep(T1), "final"]);
      expect(w.log.some((l) => l.milestone === "DUNNING_FINAL" && l.key === ep(T1))).toBe(true);

      expect((await w.sweepAt(167)).paused).toBe(0); // 167 h: one hour short of the week
      const out = await w.sweepAt(168); // 168 h, final notice exactly 24 h old, 04:00 UTC
      expect(out.paused).toBe(1);
      expect(sent(w.d).at(-1)).toEqual(["DUNNING_PAUSED", ep(T1), "paused"]); // told again, under the new key
      // the audit trail is kept: nothing deleted, the old rows are still there
      expect(w.log.filter((l) => l.key === ep(OLD))).toHaveLength(5);
    });

    it("(ii) a payment_failed webhook re-stamp after an exit: d0 again, no pause before +168 h, the PAUSED notice when it does pause", async () => {
      mode("enforced");
      // the row is unclocked when the webhook arrives; afterwards the sweep sees the clock the stamp wrote
      const w = world(oldEpisodeRows, { row: row({ pastDueInvoiceId: null, pastDueSince: null }) });
      expect(await w.d.svc.onPaymentFailed(invoice(), T1)).toBe("stamped");
      expect(w.d.tx.tenantSubscription.updateMany.mock.calls[0][0].data).toEqual({
        pastDueSince: T1,
        pastDueInvoiceId: "in_1",
      });
      expect(sent(w.d)).toEqual([["DUNNING_D0", ep(T1), "d0"]]); // not suppressed by episode 1's rows

      await w.sweepAt(144); // this episode's own final notice
      expect((await w.sweepAt(167)).paused).toBe(0); // the old FINAL cannot short-cut the week
      expect(w.d.transition).not.toHaveBeenCalled();
      expect((await w.sweepAt(168)).paused).toBe(1);
      expect(sent(w.d).at(-1)).toEqual(["DUNNING_PAUSED", ep(T1), "paused"]);
      expect(w.log.filter((l) => l.key === ep(OLD))).toHaveLength(5); // history kept
    });

    it("the OLD episode's final notice never authorises a pause in the new episode", async () => {
      mode("enforced");
      const w = world(oldEpisodeRows);
      // 200 h into the new episode, 03:00+ UTC, with a (stale) FINAL in the log under the old key
      const out = await w.sweepAt(200);
      expect(out.paused).toBe(0);
      expect(w.d.transition).not.toHaveBeenCalled();
      expect(sent(w.d)).toEqual([["DUNNING_D6", ep(T1), "final"]]); // this episode's own final goes out first
    });

    it("a pause is announced ONCE: pause at +168 h, the next hourly sweep (now paused) sends no paused_still_owed for the same episode", async () => {
      mode("enforced");
      const rows = [row({ pastDueSince: T1 })];
      const w = world([], { sweepRows: rows });
      await w.sweepAt(1);
      await w.sweepAt(144); // d6 is this episode's final notice
      expect((await w.sweepAt(168)).paused).toBe(1);
      // the next sweep re-reads the row: paused now
      rows[0] = row({
        pastDueSince: T1,
        pausedAt: at(168),
        tenant: {
          status: "READ_ONLY",
          readOnlyReason: "payment_overdue",
          deletedAt: null,
          class: "PRODUCTION",
        },
      });
      await w.sweepAt(169);
      await w.sweepAt(170);
      const kinds = sent(w.d).map((c: any[]) => c[0]);
      expect(kinds.filter((m: string) => m === "DUNNING_PAUSED")).toHaveLength(1);
      expect(kinds.filter((m: string) => m === "DUNNING_PAUSED_STILL_OWED")).toHaveLength(0);
    });

    it("(iii) within ONE episode a replayed sweep sends nothing twice: one row per milestone", async () => {
      mode("enforced");
      const w = world();
      await w.sweepAt(1);
      await w.sweepAt(1);
      await w.sweepAt(2);
      expect(sent(w.d)).toEqual([["DUNNING_D0", ep(T1), "d0"]]);
      await w.sweepAt(80);
      await w.sweepAt(81);
      const keys = w.log.map((l) => `${l.milestone}|${l.key}`);
      expect(new Set(keys).size).toBe(keys.length); // never the same (milestone, key) twice
    });

    it("the PAUSED notice carries the episode key", async () => {
      mode("enforced");
      const w = world([
        { milestone: "DUNNING_D0", sentAt: T1, key: ep(T1) },
        { milestone: "DUNNING_D3", sentAt: T1, key: ep(T1) },
        { milestone: "DUNNING_D6", sentAt: T1, key: ep(T1) },
        { milestone: "DUNNING_FINAL", sentAt: at(100), key: ep(T1) },
      ]);
      expect((await w.sweepAt(170)).paused).toBe(1);
      expect(w.d.notifications.notifyDunning).toHaveBeenCalledWith(
        "t1",
        "DUNNING_PAUSED",
        ep(T1),
        "paused",
        expect.anything(),
      );
    });
  });

  describe("A1 (SA r-note 5): dark and off are SILENT to tenants - stamp and log only", () => {
    const H = 3_600_000;
    const T = new Date("2026-11-09T04:00:00Z");
    const pausedRowT = () =>
      row({
        pastDueSince: T,
        pausedAt: new Date("2026-11-08T09:00:00Z"),
        tenant: {
          status: "READ_ONLY",
          readOnlyReason: "payment_overdue",
          deletedAt: null,
          class: "PRODUCTION",
        },
      });
    const noMail = (d: ReturnType<typeof make>) => {
      expect(d.notifications.notifyDunning).not.toHaveBeenCalled();
      expect(d.notifications.recordDunningMilestone).not.toHaveBeenCalled();
    };

    it.each(["dark", "off"])(
      "%s: a real payment_failed stamps (dark) and sends NO dunning notice",
      async (m) => {
        mode(m);
        const d = make({ row: row({ pastDueInvoiceId: null, pastDueSince: null }) });
        const out = await d.svc.onPaymentFailed(invoice(), T);
        expect(out).toBe(m === "dark" ? "stamped" : "off");
        noMail(d);
      },
    );

    it.each([1, 80, 150, 200])(
      "dark: an ACTIVE clocked tenant at +%i h gets no d0/d3/d6/final and nothing is recorded as skipped",
      async (h) => {
        mode("dark");
        const d = make({ sweepRows: [row({ pastDueSince: T })] });
        await d.svc.sweep(new Date(T.getTime() + h * H));
        noMail(d);
      },
    );

    it("dark: a PAUSED tenant (paused while enforced) gets no PAUSED_STILL_OWED either", async () => {
      mode("dark");
      const d = make({ sweepRows: [pausedRowT()] });
      await d.svc.sweep(new Date(T.getTime() + 3 * H));
      noMail(d);
    });

    it("off sweeps nothing at all", async () => {
      mode("off");
      const d = make({ sweepRows: [row({ pastDueSince: T })] });
      await d.svc.sweep(new Date(T.getTime() + 200 * H));
      noMail(d);
    });

    it("enforced: the milestone series still goes out (d0 on the stamp)", async () => {
      mode("enforced");
      const d = make({ row: row({ pastDueInvoiceId: null, pastDueSince: null }) });
      await d.svc.onPaymentFailed(invoice(), T);
      expect(d.notifications.notifyDunning).toHaveBeenCalledWith(
        "t1",
        "DUNNING_D0",
        ep(T),
        "d0",
        expect.anything(),
      );
    });

    it("enforced: d0 is told whether Stripe ATTEMPTED the invoice (attempt_count > 0) so the copy stays truthful", async () => {
      mode("enforced");
      const tried = make({ row: row({ pastDueInvoiceId: null, pastDueSince: null }) });
      await tried.svc.onPaymentFailed(invoice(), T); // OPEN_FACTS.attemptCount = 3
      expect(tried.notifications.notifyDunning.mock.calls[0][4]).toMatchObject({ attempted: true });

      const untried = make({
        row: row({ pastDueInvoiceId: null, pastDueSince: null }),
        facts: { ...OPEN_FACTS, attemptCount: 0 },
      });
      await untried.svc.onPaymentFailed(invoice(), T);
      expect(untried.notifications.notifyDunning.mock.calls[0][4]).toMatchObject({
        attempted: false,
        amountCents: 4900,
        invoiceNumber: "INV-0042",
      });
    });

    it("enforced sweep: a discovery-stamped (never attempted) clock's d0 carries attempted:false", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: T })],
        facts: { ...OPEN_FACTS, attemptCount: 0 },
      });
      await d.svc.sweep(new Date(T.getTime() + 1 * H));
      expect(d.notifications.notifyDunning).toHaveBeenCalledWith(
        "t1",
        "DUNNING_D0",
        ep(T),
        "d0",
        expect.objectContaining({ attempted: false }),
      );
    });
  });

  describe("G8: a PAUSED tenant is told ONCE per episode that it is still read-only (no d0/d3/d6/final)", () => {
    const P = new Date("2026-11-09T04:00:00Z"); // the clock was moved to this invoice while the tenant stays paused
    const H = 3_600_000;
    const pausedAtP = () =>
      row({
        pastDueSince: P,
        pausedAt: new Date("2026-11-08T09:00:00Z"),
        tenant: {
          status: "READ_ONLY",
          readOnlyReason: "payment_overdue",
          deletedAt: null,
          class: "PRODUCTION",
        },
      });
    function pausedWorld(modeName = "enforced") {
      mode(modeName);
      const log: any[] = [];
      const d = make({ sweepRows: [pausedAtP()], tz: "UTC" });
      d.prisma.billingNotificationLog.findMany.mockImplementation(async (a: any) =>
        log.filter(
          (l) =>
            l.key === a?.where?.key &&
            (!a.where.milestone?.in || a.where.milestone.in.includes(l.milestone)),
        ),
      );
      d.notifications.notifyDunning.mockImplementation(async (_t: string, m: string, k: string) => {
        log.push({ milestone: m, key: k, sentAt: P });
        return { status: "sent", recipients: 1 };
      });
      return { d, log };
    }
    const calls = (d: ReturnType<typeof make>) =>
      d.notifications.notifyDunning.mock.calls.map((c: any[]) => [c[1], c[2], c[3]]);

    it("a clock moved for an already-paused tenant: exactly one PAUSED_STILL_OWED for the episode, never d0/d3/d6/final, a replay sends none", async () => {
      const { d } = pausedWorld();
      await d.svc.sweep(new Date(P.getTime() + 1 * H));
      await d.svc.sweep(new Date(P.getTime() + 1 * H)); // replay
      await d.svc.sweep(new Date(P.getTime() + 80 * H)); // d3 would be due
      await d.svc.sweep(new Date(P.getTime() + 150 * H)); // d6 / final would be due
      await d.svc.sweep(new Date(P.getTime() + 200 * H));
      expect(calls(d)).toEqual([["DUNNING_PAUSED_STILL_OWED", ep(P), "paused_still_owed"]]);
      expect(d.notifications.recordDunningMilestone).not.toHaveBeenCalled(); // nothing "skipped" is recorded either
      expect(d.transition).not.toHaveBeenCalled(); // the tenant stays paused
    });

    it("a clock MOVED while paused: the OLD episode's PAUSED row does not stand in for the new episode - exactly one PAUSED_STILL_OWED", async () => {
      const { d, log } = pausedWorld();
      const old = new Date("2026-11-08T09:00:00Z");
      log.push({ milestone: "DUNNING_PAUSED", key: ep(old), sentAt: old }); // the pause notice of the previous episode
      await d.svc.sweep(new Date(P.getTime() + 1 * H));
      await d.svc.sweep(new Date(P.getTime() + 2 * H));
      expect(calls(d)).toEqual([["DUNNING_PAUSED_STILL_OWED", ep(P), "paused_still_owed"]]);
    });

    it("a paused tenant with no deliverable admin: ONE operator warn per episode, not one per hour", async () => {
      const { d } = pausedWorld();
      d.notifications.notifyDunning.mockResolvedValue({ status: "no_recipients", recipients: 0 });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      for (const h of [1, 2, 3, 30]) await d.svc.sweep(new Date(P.getTime() + h * H));
      const lines = warn.mock.calls
        .map((c: any[]) => String(c[0]))
        .filter((l: string) => /no_deliverable_admin/.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("tenant=t1");
      expect(lines[0]).toContain("invoice=in_1");
      expect(lines[0]).not.toMatch(/pause will never be due/); // the tenant is already paused: different wording
    });

    it("the notice names the invoice number and the amount and carries the hosted pay link", async () => {
      const { d } = pausedWorld();
      await d.svc.sweep(new Date(P.getTime() + 1 * H));
      expect(d.notifications.notifyDunning).toHaveBeenCalledWith(
        "t1",
        "DUNNING_PAUSED_STILL_OWED",
        ep(P),
        "paused_still_owed",
        expect.objectContaining({
          payUrl: "https://pay.example.test/i/in_1",
          invoiceNumber: "INV-0042",
          amountCents: 4900,
          currency: "usd",
        }),
      );
    });

    it("dark and off send nothing (A1: dark is silent to tenants, even to a tenant paused earlier)", async () => {
      const dark = pausedWorld("dark");
      await dark.d.svc.sweep(new Date(P.getTime() + 1 * H));
      expect(dark.d.notifications.notifyDunning).not.toHaveBeenCalled();
      const off = pausedWorld("off");
      await off.d.svc.sweep(new Date(P.getTime() + 1 * H));
      expect(off.d.notifications.notifyDunning).not.toHaveBeenCalled();
    });

    it("the suppressed d0/d3/d6/final are LOGGED once per episode, not hourly", async () => {
      const { d } = pausedWorld();
      const log = jest.spyOn((d.svc as any).logger, "log").mockImplementation(() => undefined);
      for (const h of [1, 2, 80, 150]) await d.svc.sweep(new Date(P.getTime() + h * H));
      const lines = log.mock.calls
        .map((c: any[]) => String(c[0]))
        .filter((l: string) => /paused_notices_suppressed/.test(l));
      expect(lines).toEqual([
        `billing.dunning.paused_notices_suppressed tenant=t1 invoice=in_1 episode=${ep(P)}`,
      ]);
    });

    it("a payment_failed stamp on a tenant that is already paused sends the still-owed notice, not d0", async () => {
      mode("enforced");
      const d = make({
        row: row({
          pastDueInvoiceId: null,
          pastDueSince: null,
          pausedAt: new Date("2026-11-08T09:00:00Z"),
          tenant: {
            status: "READ_ONLY",
            readOnlyReason: "payment_overdue",
            deletedAt: null,
            class: "PRODUCTION",
          },
        }),
      });
      expect(await d.svc.onPaymentFailed(invoice(), P)).toBe("stamped");
      expect(calls(d)).toEqual([["DUNNING_PAUSED_STILL_OWED", ep(P), "paused_still_owed"]]);
    });

    it("an ACTIVE tenant is unaffected: it still gets d0", async () => {
      mode("enforced");
      const d = make({ sweepRows: [row({ pastDueSince: P })] });
      await d.svc.sweep(new Date(P.getTime() + 1 * H));
      expect(calls(d)).toEqual([["DUNNING_D0", ep(P), "d0"]]);
    });
  });

  describe("a PAUSED tenant whose clocked invoice is no longer open", () => {
    const since = new Date("2026-11-01T00:00:00Z");
    const paused = () =>
      row({
        pastDueSince: since,
        pausedAt: new Date("2026-11-08T09:00:00Z"),
        tenant: {
          status: "READ_ONLY",
          readOnlyReason: "payment_overdue",
          deletedAt: null,
          class: "PRODUCTION",
        },
      });

    it("warns billing.dunning.paused_on_closed_invoice (tenant, invoice, status) ONCE per tenant per day; the sweep still does nothing", async () => {
      mode("enforced");
      const d = make({ sweepRows: [paused()], facts: { ...OPEN_FACTS, status: "void" } });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      const lines = () =>
        warn.mock.calls.filter((c: any[]) => /paused_on_closed_invoice/.test(String(c[0])));
      const t0 = new Date("2026-11-09T05:00:00Z");
      await d.svc.sweep(t0);
      await d.svc.sweep(new Date(t0.getTime() + 3_600_000));
      expect(lines()).toHaveLength(1);
      expect(String(lines()[0][0])).toBe(
        "billing.dunning.paused_on_closed_invoice tenant=t1 invoice=in_1 status=void",
      );
      await d.svc.sweep(new Date(t0.getTime() + 25 * 3_600_000)); // the next day
      expect(lines()).toHaveLength(2);
      expect(d.transition).not.toHaveBeenCalled();
    });

    it("paused is ONE definition (isPausedRow): READ_ONLY for another reason (cancelled) is not 'paused on a closed invoice'", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [
          row({
            pastDueSince: since,
            tenant: {
              status: "READ_ONLY",
              readOnlyReason: "subscription_cancelled",
              deletedAt: null,
              class: "PRODUCTION",
            },
          }),
        ],
        facts: { ...OPEN_FACTS, status: "void" },
      });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      await d.svc.sweep(new Date("2026-11-09T05:00:00Z"));
      expect(
        warn.mock.calls.some((c: any[]) => /paused_on_closed_invoice/.test(String(c[0]))),
      ).toBe(false);
    });

    it("an ACTIVE tenant with a closed clocked invoice does not warn (discovery clears it)", async () => {
      mode("enforced");
      const d = make({
        sweepRows: [row({ pastDueSince: since })],
        facts: { ...OPEN_FACTS, status: "void" },
      });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      await d.svc.sweep(new Date("2026-11-09T05:00:00Z"));
      expect(
        warn.mock.calls.some((c: any[]) => /paused_on_closed_invoice/.test(String(c[0]))),
      ).toBe(false);
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
        data: { pastDueInvoiceId: "in_0", pastDueSince: now },
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

    describe("the owed rule: open AND remaining > 0 AND (age >= 24 h OR attempted); the clocked invoice is never age-filtered", () => {
      const sec = (d: Date) => Math.floor(d.getTime() / 1000);
      const young = (id: string, attempts: number, hours = 2) => ({
        id,
        status: "open",
        amount_remaining: 4900,
        attempt_count: attempts,
        created: sec(new Date(now.getTime() - (hours + 1) * 3_600_000)),
        status_transitions: { finalized_at: sec(new Date(now.getTime() - hours * 3_600_000)) },
      });

      it("(a) a YOUNG clocked invoice is still owed: a paid sibling does not clear its clock", async () => {
        mode("enforced");
        const d = make({
          row: row({ pastDueInvoiceId: "in_a", pastDueSince: new Date(now.getTime() - 3_600_000) }),
          openInvoices: [young("in_a", 0)], // finalized 2 h ago, never attempted: age-filtering it was the bug
        });
        expect(await d.svc.onInvoicePaid(invoice({ id: "in_b" }), now)).toBe("unchanged");
        expect(d.prisma.$transaction).not.toHaveBeenCalled(); // clock stays, nothing resumed or cleared
        expect(d.transition).not.toHaveBeenCalled();
      });

      it("(b) a paused tenant pays the clocked invoice while a 2 h-old sibling WITH an attempt is open: stays paused, the clock MOVES (new episode), no MRR", async () => {
        mode("enforced");
        const d = make({
          row: pausedRow({ pastDueInvoiceId: "in_a" }),
          openInvoices: [young("in_s", 1)],
        });
        expect(await d.svc.onInvoicePaid(invoice({ id: "in_a" }), now)).toBe("moved");
        expect(d.transition).not.toHaveBeenCalled();
        expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
          where: { tenantId: "t1", pastDueInvoiceId: "in_a" },
          data: { pastDueInvoiceId: "in_s", pastDueSince: now },
        });
      });

      it("(c) a 2 h-old sibling with NO attempt does not hold a resume (Stripe may still collect it; payment_failed stamps it if it fails)", async () => {
        mode("enforced");
        const exit = { tenantId: "t1", stripeSubId: "sub_1", exitAt: now };
        const d = make({
          row: pausedRow({ pastDueInvoiceId: "in_a" }),
          txTenant: PAUSED,
          txClock: "in_a",
          exit,
          openInvoices: [young("in_s", 0)],
        });
        expect(await d.svc.onInvoicePaid(invoice({ id: "in_a" }), now)).toBe("resumed");
        expect(d.transition).toHaveBeenCalledTimes(1);
      });
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
      d.stripe.listOpenSubscriptionInvoices.mockRejectedValue(new Error("stripe down"));
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

    it("an UNCOLLECTIBLE sibling is the owner's write-off: it is not owed, so paying the newer failed invoice RESUMES", async () => {
      mode("enforced");
      const exit = { tenantId: "t1", stripeSubId: "sub_1", exitAt: now };
      const d = make({
        row: pausedRow(),
        txTenant: PAUSED,
        exit,
        // even if a list ever handed back a non-open row, it must not count
        openInvoices: [
          { id: "in_9", status: "uncollectible", amount_remaining: 4900, created: 1_700_300_000 },
        ],
      });
      expect(await d.svc.onInvoicePaid(invoice(), now)).toBe("resumed");
      expect(d.transition).toHaveBeenCalledTimes(1);
      expect(d.stripe.listOpenSubscriptionInvoices).toHaveBeenCalledWith("sub_1");
      // no clock was started on the uncollectible invoice
      expect(d.tx.tenantSubscription.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ pastDueInvoiceId: "in_9" }) }),
      );
    });

    it("a clock moved onto a sibling restarts at the move time, as a NEW episode", async () => {
      mode("enforced");
      const d = make({
        row: pausedRow({ pastDueInvoiceId: "in_2" }),
        openInvoices: [
          { id: "in_0", status: "open", amount_remaining: 4900, created: 1_700_000_000 },
        ],
      });
      expect(await d.svc.onInvoicePaid(invoice({ id: "in_1" }), now)).toBe("moved");
      expect(d.tx.tenantSubscription.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "t1", pastDueInvoiceId: "in_2" },
        data: { pastDueInvoiceId: "in_0", pastDueSince: now },
      });
    });

    it("follow-through: the clock moved to B while paused, then invoice.paid of B RESUMES on the new clock (+MRR once)", async () => {
      mode("enforced");
      const exit = { tenantId: "t1", stripeSubId: "sub_1", exitAt: now };
      // webhook 1: A (the clock) is paid while B is open -> the clock moves to B, still paused
      const mv = make({
        row: pausedRow({ pastDueInvoiceId: "in_a" }),
        openInvoices: [
          { id: "in_b", status: "open", amount_remaining: 4900, created: 1_700_000_000 },
        ],
      });
      expect(await mv.svc.onInvoicePaid(invoice({ id: "in_a" }), now)).toBe("moved");
      expect(mv.transition).not.toHaveBeenCalled();
      const moved = mv.tx.tenantSubscription.updateMany.mock.calls[0][0].data;
      expect(moved).toEqual({ pastDueInvoiceId: "in_b", pastDueSince: now });
      // webhook 2: B is paid; the row now carries the moved clock
      const later = new Date(now.getTime() + 3_600_000);
      const rs = make({
        row: pausedRow({ pastDueInvoiceId: "in_b", pastDueSince: moved.pastDueSince }),
        txTenant: PAUSED,
        txClock: "in_b",
        exit,
        openInvoices: [],
      });
      expect(await rs.svc.onInvoicePaid(invoice({ id: "in_b" }), later)).toBe("resumed");
      expect(rs.transition).toHaveBeenCalledTimes(1);
      expect(rs.transition.mock.calls[0].slice(0, 5)).toEqual([
        "t1",
        { status: "READ_ONLY", readOnlyReason: "payment_overdue" },
        "ACTIVE",
        1,
        BILLING_EVENTS.SUBSCRIPTION_RESUMED,
      ]);
    });

    it("paid(A) then a LOST paid(B): the clock moved to B, and the hourly sweep self-heals - it finds B paid and resumes", async () => {
      mode("enforced");
      const exit = { tenantId: "t1", stripeSubId: "sub_1", exitAt: now };
      const d = make({
        row: pausedRow({ pastDueInvoiceId: "in_a" }),
        // the sweep reads the row AFTER the move: clocked on B, still paused
        sweepRows: [pausedRow({ pastDueInvoiceId: "in_b", pastDueSince: now })],
        txTenant: PAUSED,
        txClock: "in_b",
        exit,
        facts: { ...OPEN_FACTS, status: "paid", amountRemaining: 0, amountPaid: 4900 },
      });
      d.stripe.listOpenSubscriptionInvoices.mockResolvedValueOnce([
        { id: "in_b", status: "open", amount_remaining: 4900, created: 1_700_000_000 },
      ]);
      expect(await d.svc.onInvoicePaid(invoice({ id: "in_a" }), now)).toBe("moved");
      expect(d.transition).not.toHaveBeenCalled();
      // paid(B) never arrives; one hour later the sweep reads B from Stripe
      const out = await d.svc.sweep(new Date(now.getTime() + 3_600_000));
      expect(out.resolved).toBe(1);
      expect(d.transition).toHaveBeenCalledTimes(1);
      expect(d.transition.mock.calls[0][2]).toBe("ACTIVE");
      expect(d.guard.invalidate).toHaveBeenCalledWith("t1");
    });

    it("(iv) moved BACK onto an invoice that was clocked before: a NEW episode, and the old episode's FINAL cannot authorise a pause (a real sweep)", async () => {
      mode("enforced");
      const old = new Date("2026-10-20T00:00:00Z");
      const oldRows = ["DUNNING_D0", "DUNNING_D3", "DUNNING_D6", "DUNNING_FINAL"].map((m) => ({
        milestone: m,
        sentAt: old,
        key: ep(old, "in_0"),
      }));
      const mv = make({
        row: pausedRow({ pastDueInvoiceId: "in_2" }),
        openInvoices: [
          { id: "in_0", status: "open", amount_remaining: 4900, created: 1_700_000_000 },
        ],
        logged: oldRows,
      });
      expect(await mv.svc.onInvoicePaid(invoice({ id: "in_1" }), now)).toBe("moved");
      const data = mv.tx.tenantSubscription.updateMany.mock.calls[0][0].data;
      expect(data).toEqual({ pastDueInvoiceId: "in_0", pastDueSince: now });

      // the sweep that follows: ACTIVE-and-clocked again (the pause was exited), 200 h into the NEW episode, 13:00Z
      const later = new Date(now.getTime() + 200 * 3_600_000);
      const sw = make({
        sweepRows: [row({ pastDueInvoiceId: "in_0", pastDueSince: data.pastDueSince })],
        logged: oldRows,
      });
      const out = await sw.svc.sweep(later);
      expect(out.paused).toBe(0);
      expect(sw.transition).not.toHaveBeenCalled();
      // this episode's own final notice goes out first (d0/d3 skipped): the lead time starts now, not in October
      expect(sw.notifications.notifyDunning).toHaveBeenCalledWith(
        "t1",
        "DUNNING_D6",
        ep(data.pastDueSince, "in_0"),
        "final",
        expect.anything(),
      );
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

    it("would_unpause is logged ONCE per tenant per window, not every hourly run", async () => {
      mode("dark");
      const d = make({
        ...subs(),
        stripeSub: { status: "active", pause_collection: { behavior: "void" } },
        localPausedAt: null,
      });
      const warn = jest.spyOn((d.svc as any).logger, "warn").mockImplementation(() => undefined);
      const lines = () =>
        warn.mock.calls.filter((c: any[]) => /would_unpause/.test(String(c[0]))).length;
      await d.svc.reconcile(runAt);
      await d.svc.reconcile(new Date(runAt.getTime() + 3_600_000));
      await d.svc.reconcile(new Date(runAt.getTime() + 2 * 3_600_000));
      expect(lines()).toBe(1);
      await d.svc.reconcile(new Date(runAt.getTime() + 26 * 3_600_000)); // the next day's window
      expect(lines()).toBe(2);
    });

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
