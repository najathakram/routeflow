/**
 * Lead ruling R1 (option B): a scheduled downgrade's price reaches Stripe BEFORE the renewal invoice - on the
 * `invoice.upcoming` webhook, with an hourly backup sweep for the last 48 h - and never after the period end.
 * ONE idempotent function under the tenant-price lock; Stripe's own base amount is the "applied" marker.
 * Stripe is a stateful fake (no network).
 */
const mockLockQueues = new Map<string, Promise<unknown>>();
const mockWithAdvisoryLock = jest.fn(
  async (opts: { family: string; key: string }, fn: () => Promise<unknown>) => {
    const id = `${opts.family}:${opts.key}`;
    const prior = mockLockQueues.get(id) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    mockLockQueues.set(
      id,
      prior.then(() => done),
    );
    await prior;
    try {
      return { acquired: true as const, value: await fn() };
    } finally {
      release();
    }
  },
);
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: mockWithAdvisoryLock,
  LockTimeoutError: class LockTimeoutError extends Error {},
  LockUnavailableError: class LockUnavailableError extends Error {},
}));

import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { BillingService } from "./billing.service";
import { ScheduledPriceChangeService, SCHEDULED_PRICE_LEAD_MS } from "./scheduled-price-change";
import { fakeStripeSubscription } from "../testing/fake-stripe-subscription";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-28T12:00:00.000Z");
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * HOUR);
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

const CATALOG = {
  id: "v7",
  definitions: [
    { planKey: "STARTER", name: "Starter", monthlyPrice: 59, annualPrice: null },
    { planKey: "BUSINESS", name: "Business", monthlyPrice: 349, annualPrice: null },
  ],
  addonSkus: [],
};

const baseItem = (over: Record<string, unknown> = {}, recurring: any = { interval: "month" }) => ({
  id: "si_base",
  quantity: 1,
  current_period_start: epoch(at(-24 * 28)),
  current_period_end: epoch(at(48)),
  price: { unit_amount: 34900, currency: "usd", recurring, product: "prod_business", ...over },
});

interface SubRow {
  tenantId: string;
  planKey: string;
  planVersionId: string;
  stripeSubId: string | null;
  priceOverrideMonthly: number | null;
  priceOverrideAnnual: number | null;
  downgradeToPlanKey: string | null;
  downgradeEffectiveAt: Date | null;
  tenant: { status: string; deletedAt: Date | null };
}

function row(over: Partial<SubRow> = {}): SubRow {
  return {
    tenantId: "t1",
    planKey: "BUSINESS",
    planVersionId: "v7",
    stripeSubId: "sub_1",
    priceOverrideMonthly: null,
    priceOverrideAnnual: null,
    downgradeToPlanKey: "STARTER",
    downgradeEffectiveAt: at(48),
    tenant: { status: "ACTIVE", deletedAt: null },
    ...over,
  };
}

function make(rows: SubRow[] = [row()], items: any[] = [baseItem()]) {
  const prisma: any = {
    tenantSubscription: {
      findUnique: jest.fn(
        async ({ where }: any) => rows.find((r) => r.tenantId === where.tenantId) ?? null,
      ),
      // honours the sweep's window so "T-48h / after the period end" is tested through the real filter
      findMany: jest.fn(async ({ where }: any) =>
        rows
          .filter(
            (r) =>
              r.stripeSubId &&
              r.downgradeToPlanKey &&
              r.downgradeEffectiveAt &&
              r.downgradeEffectiveAt > where.downgradeEffectiveAt.gt &&
              r.downgradeEffectiveAt <= where.downgradeEffectiveAt.lte &&
              r.tenant.status === "ACTIVE",
          )
          .map((r) => ({ tenantId: r.tenantId })),
      ),
    },
    tenantAddon: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const stripe = fakeStripeSubscription(items);
  const catalog: any = {
    getVersionForTenant: jest.fn().mockResolvedValue(CATALOG),
    getPublishedVersion: jest.fn().mockResolvedValue(null),
  };
  const svc = new ScheduledPriceChangeService(prisma, stripe as any, catalog);
  return { svc, prisma, stripe, catalog, rows };
}

beforeEach(() => {
  mockLockQueues.clear();
  mockWithAdvisoryLock.mockClear();
});

describe("applyScheduledPriceChange (ScheduledPriceChangeService.apply)", () => {
  it("pushes the scheduled target price ONCE, proration none, with the (sub, effectiveAt, version) key", async () => {
    const { svc, stripe } = make();
    const out = await svc.apply("t1", NOW);

    expect(out).toMatchObject({ applied: true, amountCents: 5900, priorAmountCents: 34900 });
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    const [subId, params, opts] = stripe.updateSubscription.mock.calls[0];
    expect(subId).toBe("sub_1");
    expect(params.proration_behavior).toBe("none");
    expect(params.items).toEqual([
      {
        id: "si_base",
        price_data: {
          currency: "usd",
          unit_amount: 5900,
          recurring: { interval: "month" },
          product: "prod_scale",
        },
      },
    ]);
    expect(opts.idempotencyKey).toBe(
      `sub_1:scheduled-price:${at(48).toISOString()}:v7:STARTER:34900-5900:-`,
    );
    expect(stripe.amountOf("si_base")).toBe(5900);
  });

  it("runs under the tenant-price lock, re-reading the row under it (the family the upgrade and the override take)", async () => {
    const { svc, prisma } = make();
    await svc.apply("t1", NOW);
    expect(mockWithAdvisoryLock).toHaveBeenCalledWith(
      { family: "tenant-price", key: "t1", mode: "wait", waitMs: 20_000 },
      expect.any(Function),
    );
    expect(mockWithAdvisoryLock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.tenantSubscription.findUnique.mock.invocationCallOrder[0],
    );
  });

  it("the tenant's custom fee WINS over the target plan's price", async () => {
    const { svc, stripe } = make([row({ priceOverrideMonthly: 180 })]);
    await svc.apply("t1", NOW);
    expect(stripe.updateSubscription.mock.calls[0][1].items[0].price_data.unit_amount).toBe(18000);
  });

  it("a replay (a second call, or the same webhook redelivered) is a no-op: Stripe already bills the target", async () => {
    const { svc, stripe } = make();
    await svc.apply("t1", NOW);
    const second = await svc.apply("t1", NOW);

    expect(second).toEqual({ applied: false, reason: "already_applied" });
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
  });

  it("two concurrent calls serialise on the lock: exactly ONE push (no double push)", async () => {
    const { svc, stripe } = make();
    const [a, b] = await Promise.all([svc.apply("t1", NOW), svc.apply("t1", NOW)]);

    expect([a.applied, b.applied].sort()).toEqual([false, true]);
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
  });

  it("a lock collision is a coded 409 and NOTHING is read or sent", async () => {
    const { LockTimeoutError } = jest.requireMock("../common/db-locks");
    mockWithAdvisoryLock.mockRejectedValueOnce(new LockTimeoutError());
    const { svc, stripe } = make();

    const err: any = await svc.apply("t1", NOW).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().code).toBe("CONCURRENT_UPDATE");
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("a custom-fee tenant whose price does not change needs no push at all", async () => {
    const { svc, stripe } = make([row({ priceOverrideMonthly: 349 })]);
    expect(await svc.apply("t1", NOW)).toEqual({ applied: false, reason: "already_applied" });
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(stripe.client.products.create).not.toHaveBeenCalled();
  });

  it("NEVER after the period end: nothing is read or sent once the downgrade's date has passed", async () => {
    const { svc, stripe } = make([row({ downgradeEffectiveAt: at(-1) })]);
    expect(await svc.apply("t1", NOW)).toEqual({ applied: false, reason: "period_ended" });
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("... and Stripe's own period end is honoured too (the renewal is already behind us)", async () => {
    const { svc, stripe } = make([row()], [baseItem({}, { interval: "month" })]);
    stripe.state.items[0].current_period_end = epoch(at(-1));
    expect(await svc.apply("t1", NOW)).toEqual({ applied: false, reason: "period_ended" });
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ["no Stripe subscription (manual-pay)", { stripeSubId: null }],
    ["no scheduled downgrade", { downgradeToPlanKey: null, downgradeEffectiveAt: null }],
    ["an inactive tenant", { tenant: { status: "SUSPENDED", deletedAt: null } }],
  ])("a tenant with %s is a no-op that never touches Stripe", async (_l, over) => {
    const { svc, stripe } = make([row(over as Partial<SubRow>)]);
    const out = await svc.apply("t1", NOW);
    expect(out.applied).toBe(false);
    expect(stripe.getSubscription).not.toHaveBeenCalled();
  });

  it.each([
    ["an ANNUAL item", { interval: "year" }],
    [
      "a monthly item billed every 3 months (interval_count 3)",
      { interval: "month", interval_count: 3 },
    ],
  ])("%s is REFUSED with a coded error and nothing is sent", async (_l, recurring) => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe } = make([row()], [baseItem({}, recurring)]);

    const err: any = await svc.apply("t1", NOW).catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().code).toBe("SCHEDULED_PRICE_CHANGE_REFUSED");
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("an unreadable Stripe is a 503 and nothing is sent", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe } = make();
    stripe.getSubscription.mockRejectedValueOnce(new Error("stripe down"));
    await expect(svc.apply("t1", NOW)).rejects.toMatchObject({ status: 503 });
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("a paused / cancelled Stripe subscription is left alone", async () => {
    const { svc, stripe } = make();
    stripe.state.status = "canceled";
    expect((await svc.apply("t1", NOW)).applied).toBe(false);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });
});

describe("restoreAfterScheduleCleared (Keep current plan after the lower price was pushed)", () => {
  // The tenant kept BUSINESS (349); STARTER (59) had been pushed for the renewal.
  const kept = (over: Partial<SubRow> = {}) =>
    row({ downgradeToPlanKey: null, downgradeEffectiveAt: null, ...over });

  it("puts Stripe back on the kept plan's price (proration none) when it still bills the cleared target", async () => {
    const { svc, stripe } = make([kept()], [baseItem({ unit_amount: 5900 })]);
    await svc.restoreAfterScheduleCleared("t1", "STARTER");

    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    const [, params, opts] = stripe.updateSubscription.mock.calls[0];
    expect(params.proration_behavior).toBe("none");
    expect(params.items[0].price_data.unit_amount).toBe(34900);
    expect(opts.idempotencyKey).toContain("scheduled-price-restore");
    expect(stripe.amountOf("si_base")).toBe(34900);
  });

  it("leaves Stripe alone when it was never pushed (still the kept price), or when something else moved it", async () => {
    const never = make([kept()], [baseItem()]); // 34900 already
    await never.svc.restoreAfterScheduleCleared("t1", "STARTER");
    const other = make([kept()], [baseItem({ unit_amount: 12345 })]);
    await other.svc.restoreAfterScheduleCleared("t1", "STARTER");
    expect(never.stripe.updateSubscription).not.toHaveBeenCalled();
    expect(other.stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("does nothing while a (re-)scheduled downgrade exists, and for a custom fee whose price never moved", async () => {
    const resched = make(
      [kept({ downgradeToPlanKey: "STARTER", downgradeEffectiveAt: at(48) })],
      [baseItem({ unit_amount: 5900 })],
    );
    await resched.svc.restoreAfterScheduleCleared("t1", "STARTER");
    const fee = make([kept({ priceOverrideMonthly: 200 })], [baseItem({ unit_amount: 20000 })]);
    await fee.svc.restoreAfterScheduleCleared("t1", "STARTER");
    expect(resched.stripe.updateSubscription).not.toHaveBeenCalled();
    expect(fee.stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("a failure is ALERTED and never thrown to the tenant whose resume already committed", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe } = make([kept()], [baseItem({ unit_amount: 5900 })]);
    stripe.getSubscription.mockRejectedValueOnce(new Error("stripe down"));
    await expect(svc.restoreAfterScheduleCleared("t1", "STARTER")).resolves.toBeUndefined();
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("needs_reconcile");
    error.mockRestore();
  });
});

describe("the idempotency key names the state it moves between (review)", () => {
  it("push -> restore -> re-push of the SAME schedule goes out under a DIFFERENT key (Stripe never replays the first)", async () => {
    const { svc, stripe, rows } = make();
    await svc.apply("t1", NOW); // 34900 -> 5900
    const firstKey = stripe.updateSubscription.mock.calls[0][2].idempotencyKey;

    // The tenant keeps its plan: the schedule is cleared and Stripe is put back (34900)...
    const schedule = { to: rows[0].downgradeToPlanKey, at: rows[0].downgradeEffectiveAt };
    rows[0].downgradeToPlanKey = null;
    rows[0].downgradeEffectiveAt = null;
    await svc.restoreAfterScheduleCleared("t1", "STARTER");
    expect(stripe.amountOf("si_base")).toBe(34900);

    // ... and later schedules the very same downgrade again (same effective date).
    rows[0].downgradeToPlanKey = schedule.to;
    rows[0].downgradeEffectiveAt = schedule.at;
    await svc.apply("t1", NOW);

    const last = stripe.updateSubscription.mock.calls.at(-1)!;
    expect(last[1].items[0].price_data.unit_amount).toBe(5900);
    expect(last[2].idempotencyKey).not.toBe(firstKey);
    expect(stripe.amountOf("si_base")).toBe(5900);
  });
});

describe("restoreIfPushedLocked (the caller holds the lock and is about to prorate)", () => {
  const kept = (over: Partial<SubRow> = {}) => row({ ...over });

  it("LOW: an unresolvable price THROWS a coded error for a caller that is about to prorate (it must not go on blind)", async () => {
    const { svc, stripe, catalog } = make([kept()], [baseItem({ unit_amount: 5900 })]);
    catalog.getVersionForTenant.mockResolvedValue({
      ...CATALOG,
      definitions: [{ planKey: "BUSINESS", name: "Business", monthlyPrice: null }],
    });
    const err: any = await svc
      .restoreIfPushedLocked("t1", "STARTER", { mustBeCleared: false })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse().code).toBe("SCHEDULED_PRICE_CHANGE_REFUSED");
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("... but a best-effort caller (resume / cancel, already committed) just returns", async () => {
    const { svc, catalog } = make(
      [kept({ downgradeToPlanKey: null, downgradeEffectiveAt: null })],
      [baseItem({ unit_amount: 5900 })],
    );
    catalog.getVersionForTenant.mockResolvedValue({
      ...CATALOG,
      definitions: [{ planKey: "BUSINESS", name: "Business", monthlyPrice: null }],
    });
    await expect(
      svc.restoreIfPushedLocked("t1", "STARTER", { mustBeCleared: true }),
    ).resolves.toBeUndefined();
  });

  it("LOW: a target a grandfathered pin predates is priced from the published catalog (as apply() does) and restored", async () => {
    // The pinned version has no LITE; the published one prices it at 59. Stripe holds the pushed 5900.
    const { svc, stripe, catalog } = make(
      [kept({ downgradeToPlanKey: "LITE" })],
      [baseItem({ unit_amount: 5900 })],
    );
    catalog.getPublishedVersion.mockResolvedValue({
      ...CATALOG,
      definitions: [
        ...CATALOG.definitions,
        { planKey: "LITE", name: "Lite", monthlyPrice: 59, annualPrice: null },
      ],
    });
    await svc.restoreIfPushedLocked("t1", "LITE", { mustBeCleared: false });
    expect(stripe.amountOf("si_base")).toBe(34900);
  });
});

describe("restoreAfterScheduleCleared under a lock collision", () => {
  it("NIT: a lock timeout is ALERTED (needs_reconcile), nothing is sent, and the lock is tried exactly once (no retry)", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { LockTimeoutError } = jest.requireMock("../common/db-locks");
    mockWithAdvisoryLock.mockRejectedValueOnce(new LockTimeoutError());
    const { svc, stripe } = make(
      [row({ downgradeToPlanKey: null, downgradeEffectiveAt: null })],
      [baseItem({ unit_amount: 5900 })],
    );

    await expect(svc.restoreAfterScheduleCleared("t1", "STARTER")).resolves.toBeUndefined();

    expect(mockWithAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("needs_reconcile");
    error.mockRestore();
  });
});

describe("the backup sweep (applyDue)", () => {
  it("pushes at T-48h when the webhook was missed", async () => {
    const { svc, stripe } = make([row({ downgradeEffectiveAt: at(48) })]);
    expect(await svc.applyDue(NOW)).toEqual({ pushed: 1, held: 0 });
    expect(stripe.amountOf("si_base")).toBe(5900);
  });

  it("does nothing yet earlier than 48 h before the period end", async () => {
    const { svc, stripe } = make([row({ downgradeEffectiveAt: at(49) })]);
    expect(await svc.applyDue(NOW)).toEqual({ pushed: 0, held: 0 });
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(SCHEDULED_PRICE_LEAD_MS).toBe(48 * HOUR);
  });

  it("NEVER after the period end: a past-due date is not even a candidate", async () => {
    const { svc, stripe } = make([row({ downgradeEffectiveAt: at(-1) })]);
    expect(await svc.applyDue(NOW)).toEqual({ pushed: 0, held: 0 });
    expect(stripe.getSubscription).not.toHaveBeenCalled();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("is idempotent across ticks and with the webhook that already did the job", async () => {
    const { svc, stripe } = make();
    await svc.apply("t1", NOW); // the webhook
    expect(await svc.applyDue(NOW)).toEqual({ pushed: 0, held: 0 });
    expect(await svc.applyDue(NOW)).toEqual({ pushed: 0, held: 0 });
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
  });

  it("one tenant that cannot be pushed is held back and never stops the next", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { svc, stripe } = make(
      [row(), row({ tenantId: "t2", stripeSubId: "sub_2" })],
      [baseItem()],
    );
    stripe.getSubscription.mockRejectedValueOnce(new Error("stripe down"));
    expect(await svc.applyDue(NOW)).toEqual({ pushed: 1, held: 1 });
    error.mockRestore();
  });
});

describe("the invoice.upcoming webhook", () => {
  function wire(rows: SubRow[] = [row()], items: any[] = [baseItem()]) {
    const m = make(rows, items);
    const billingPrisma: any = {
      tenantSubscription: {
        findFirst: jest.fn(async ({ where }: any) => {
          const r = rows.find((x) => x.stripeSubId === where.stripeSubId);
          return r
            ? {
                ...r,
                stripeCustomerId: "cus_1",
                tenant: { id: r.tenantId, slug: "acme", name: "Acme" },
              }
            : null;
        }),
      },
    };
    const billing = new BillingService(
      billingPrisma,
      m.stripe as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      m.svc,
    );
    const evt = (over: Record<string, unknown> = {}) => ({
      id: "evt_up_1",
      type: "invoice.upcoming",
      data: {
        object: {
          customer: "cus_1",
          parent: { subscription_details: { subscription: "sub_1" } },
          ...over,
        },
      },
    });
    return { ...m, billing, evt };
  }

  it("a scheduled downgrade is pushed once when Stripe announces the renewal", async () => {
    const { billing, evt, stripe } = wire();
    await billing.handleWebhookEvent(evt());
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
    expect(stripe.amountOf("si_base")).toBe(5900);
  });

  it("the same event delivered again is a no-op (the push itself is idempotent)", async () => {
    const { billing, evt, stripe } = wire();
    await billing.handleWebhookEvent(evt());
    await billing.handleWebhookEvent(evt());
    expect(stripe.updateSubscription).toHaveBeenCalledTimes(1);
  });

  it("an invoice for another customer or subscription is ignored", async () => {
    const { billing, evt, stripe } = wire();
    await billing.handleWebhookEvent(evt({ customer: "cus_other" }));
    await billing.handleWebhookEvent(
      evt({ parent: { subscription_details: { subscription: "sub_nope" } } }),
    );
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("a refusal (an annual item) is alerted and ACKNOWLEDGED - a redelivery could never succeed", async () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { billing, evt, stripe } = wire([row()], [baseItem({}, { interval: "year" })]);
    await expect(billing.handleWebhookEvent(evt())).resolves.toBeUndefined();
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("cannot be applied");
    error.mockRestore();
  });

  it("a lock collision FAILS the webhook (Stripe redelivers) and pushes nothing", async () => {
    const { LockTimeoutError } = jest.requireMock("../common/db-locks");
    mockWithAdvisoryLock.mockRejectedValueOnce(new LockTimeoutError());
    const { billing, evt, stripe } = wire();
    await expect(billing.handleWebhookEvent(evt())).rejects.toBeInstanceOf(ConflictException);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it("without the scheduled-price service the event is acknowledged and ignored (older wiring)", async () => {
    const billing = new BillingService(
      { tenantSubscription: { findFirst: jest.fn() } } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    await expect(
      billing.handleWebhookEvent({ id: "e", type: "invoice.upcoming", data: { object: {} } }),
    ).resolves.toBeUndefined();
  });
});
