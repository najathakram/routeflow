// SA-736r: the single coupon-column writer and the Stripe sync. A small STATEFUL fake stands in for the
// transaction client, so the specs assert END state (columns + ledger sum), not call shapes. Stripe is
// mocked at the StripeService boundary: no live call exists anywhere here.
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  applyCouponState,
  applyCouponStateTx,
  resetCouponState,
  syncCouponFromStripe,
} from "./coupon-state";
import { NO_COUPON } from "./coupon-unbilled";

interface Row {
  couponFull: boolean;
  couponId: string | null;
  couponEndsAt: Date | null;
  couponSyncedAt: Date | null;
  stripeSubId: string | null;
  externalPayment: boolean;
  planKey: string | null;
  basePriceSnapshot: number | null;
  discount: number | null;
}

function harness(
  over: Partial<Row> = {},
  tenant: Record<string, unknown> = {},
  addons: Array<{ priceSnapshot: number | null; quantity: number }> = [],
) {
  const row: Row = {
    couponFull: false,
    couponId: null,
    couponEndsAt: null,
    couponSyncedAt: null,
    stripeSubId: "sub_acme",
    externalPayment: false,
    planKey: "STARTER",
    basePriceSnapshot: 99,
    discount: 0,
    ...over,
  };
  const t = { status: "ACTIVE", class: "PRODUCTION", deletedAt: null, ...tenant };
  const ledger: Array<{ type: string; amountDelta: number }> = [];
  const order: string[] = [];
  const matches = (where: any): boolean => {
    if ("couponFull" in where && where.couponFull !== row.couponFull) return false;
    if (where.OR) {
      const ok = where.OR.some((c: any) =>
        "couponSyncedAt" in c && c.couponSyncedAt === null
          ? row.couponSyncedAt === null
          : row.couponSyncedAt !== null &&
            row.couponSyncedAt.getTime() < c.couponSyncedAt.lt.getTime(),
      );
      if (!ok) return false;
    }
    return true;
  };
  const tx: any = {
    tenantSubscription: {
      findUnique: jest.fn(async ({ select }: any) => {
        order.push("tx.read");
        const out: any = { ...row };
        if (select?.tenant) out.tenant = { ...t };
        return out;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    tenantAddon: { findMany: jest.fn(async () => addons) },
    $queryRaw: jest.fn(async () => {
      order.push("tenant.lock");
      return [];
    }),
  };
  const prisma: any = {
    $transaction: jest.fn(async (fn: any) => {
      order.push("tx.open");
      return fn(tx);
    }),
    tenantSubscription: {
      findUnique: jest.fn(async () => ({
        stripeSubId: row.stripeSubId,
        externalPayment: row.externalPayment,
      })),
    },
  };
  const events: any = {
    emit: jest.fn(async (_tenantId: string, type: string, _payload: unknown, opts: any) => {
      ledger.push({ type, amountDelta: opts.amountDelta });
    }),
  };
  return { row, tx, prisma, events, ledger, order };
}

const sum = (ledger: Array<{ amountDelta: number }>) =>
  Math.round(ledger.reduce((s, e) => s + e.amountDelta, 0) * 100) / 100;

describe("applyCouponState: the ledger crossing (M1)", () => {
  it("entry books -X once (X = base + billable add-ons - discount); a replay adds nothing", async () => {
    const h = harness({ basePriceSnapshot: 99, discount: 9 }, {}, [
      { priceSnapshot: 20, quantity: 2 },
    ]);
    const full = { full: true, couponId: "cp_pilot", endsAt: null };
    const a = await applyCouponState(h, "t1", full, { reason: "test", syncedAt: new Date(1000) });
    expect(a).toMatchObject({ applied: true, amountDelta: -130 });
    expect(h.row).toMatchObject({ couponFull: true, couponId: "cp_pilot" });
    expect(h.ledger).toEqual([{ type: "coupon.unbilled", amountDelta: -130 }]);

    const replay = await applyCouponState(h, "t1", full, {
      reason: "test",
      syncedAt: new Date(2000),
    });
    expect(replay.amountDelta).toBe(0);
    expect(h.ledger).toHaveLength(1);
  });

  it("entry -> exit round trip: -X then +X, ledger sum 0 (so mrr == ledgerMrr)", async () => {
    const h = harness({ basePriceSnapshot: 99 }, {}, [{ priceSnapshot: 20, quantity: 1 }]);
    await applyCouponState(
      h,
      "t1",
      { full: true, couponId: "cp", endsAt: null },
      { reason: "in", syncedAt: new Date(1000) },
    );
    await applyCouponState(h, "t1", NO_COUPON, { reason: "out", syncedAt: new Date(2000) });
    expect(h.ledger.map((e) => e.amountDelta)).toEqual([-119, 119]);
    expect(h.ledger.map((e) => e.type)).toEqual(["coupon.unbilled", "coupon.billed"]);
    expect(sum(h.ledger)).toBe(0);
    expect(h.row.couponFull).toBe(false);
  });

  it("a coupon added while SUSPENDED books 0 (not paying on either side)", async () => {
    const h = harness({}, { status: "SUSPENDED" }, []);
    const r = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: "cp", endsAt: null },
      { reason: "x", syncedAt: new Date(1) },
    );
    expect(r).toMatchObject({ applied: true, amountDelta: 0 });
    expect(h.row.couponFull).toBe(true);
    expect(h.ledger).toEqual([]);
  });

  it("A: SUSPENDED + couponFull, the coupon ends, then the tenant is ACTIVE again: the exit books exactly +X", async () => {
    // reinstatement (transitionAndEmit) read couponFull=true and booked 0; the sync that follows books +X.
    const h = harness({ couponFull: true, basePriceSnapshot: 99 }, { status: "ACTIVE" }, []);
    const r = await applyCouponState(h, "t1", NO_COUPON, {
      reason: "payment_succeeded",
      syncedAt: new Date(5),
    });
    expect(r.amountDelta).toBe(99);
    expect(sum(h.ledger)).toBe(99);
  });

  it("a planKey-less row is not paying: nothing is booked on either side", async () => {
    const h = harness({ planKey: null });
    const r = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: null, endsAt: null },
      { reason: "x", syncedAt: new Date(1) },
    );
    expect(r.amountDelta).toBe(0);
    expect(h.ledger).toEqual([]);
  });

  it("a zero contribution books no event", async () => {
    const h = harness({ basePriceSnapshot: 0 });
    await applyCouponState(
      h,
      "t1",
      { full: true, couponId: null, endsAt: null },
      { reason: "x", syncedAt: new Date(1) },
    );
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("bookDelta:false writes the columns and books nothing (the caller books its own crossing)", async () => {
    const h = harness({ couponFull: true });
    await applyCouponState(h, "t1", NO_COUPON, { reason: "manual_activation", bookDelta: false });
    expect(h.row.couponFull).toBe(false);
    expect(h.events.emit).not.toHaveBeenCalled();
  });
});

describe("applyCouponState: ordering and lost updates (F3, F4)", () => {
  it("the wrapper takes the Tenant lock FIRST, inside its own tx; the Tx form opens no transaction", async () => {
    const h = harness();
    await applyCouponState(h, "t1", NO_COUPON, { reason: "x", syncedAt: new Date(1) });
    expect(h.order.slice(0, 3)).toEqual(["tx.open", "tenant.lock", "tx.read"]);

    const g = harness();
    await applyCouponStateTx(g.tx, g.events, "t1", NO_COUPON, {
      reason: "x",
      tenantLockHeld: true,
    });
    expect(g.prisma.$transaction).not.toHaveBeenCalled();
    expect(g.order).not.toContain("tx.open");
  });

  it("F4: an older read that commits later is a no-op (stored couponSyncedAt is newer)", async () => {
    const h = harness();
    const newer = await applyCouponState(h, "t1", NO_COUPON, {
      reason: "event 2",
      syncedAt: new Date(2000),
    });
    expect(newer.applied).toBe(true);
    const older = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: "cp", endsAt: null },
      { reason: "event 1", syncedAt: new Date(1000) },
    );
    expect(older).toMatchObject({ applied: false, stale: true });
    expect(h.row.couponFull).toBe(false);
    expect(h.row.couponSyncedAt).toEqual(new Date(2000));
    expect(h.ledger).toEqual([]);
  });

  it("F4: the CAS itself refuses a write when couponSyncedAt moved between the read and the write", async () => {
    const h = harness();
    const real = h.tx.tenantSubscription.updateMany;
    h.tx.tenantSubscription.updateMany = jest.fn(async (args: any) => {
      h.row.couponSyncedAt = new Date(9000); // a concurrent writer lands in between
      return real(args);
    });
    const r = await applyCouponStateTx(
      h.tx,
      h.events,
      "t1",
      { full: true, couponId: null, endsAt: null },
      { reason: "x", syncedAt: new Date(1000), tenantLockHeld: true },
    );
    expect(r.stale).toBe(true);
    expect(h.row.couponFull).toBe(false);
  });

  it("a reset stamps 'now', so a Stripe read that STARTED before it cannot resurrect the coupon", async () => {
    const h = harness({ couponFull: true });
    const t0 = new Date(Date.now() - 60_000); // a retrieve that began a minute ago
    await resetCouponState(h, "t1", "stripe_subscription_deleted");
    expect(h.row).toMatchObject({ couponFull: false, couponId: null, couponEndsAt: null });
    const late = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: "cp", endsAt: null },
      { reason: "late", syncedAt: t0 },
    );
    expect(late.stale).toBe(true);
    expect(h.row.couponFull).toBe(false);
  });

  it("a sync for a replaced Stripe subscription is a no-op (onlyStripeSubId)", async () => {
    const h = harness({ stripeSubId: "sub_new" });
    const r = await applyCouponState(
      h,
      "t1",
      { full: true, couponId: null, endsAt: null },
      { reason: "x", syncedAt: new Date(1), onlyStripeSubId: "sub_old" },
    );
    expect(r.stale).toBe(true);
    expect(h.row.couponFull).toBe(false);
  });

  it("no subscription row: nothing happens", async () => {
    const h = harness();
    h.tx.tenantSubscription.findUnique.mockResolvedValue(null);
    expect(await applyCouponState(h, "t1", NO_COUPON, { reason: "x" })).toMatchObject({
      applied: false,
      stale: false,
    });
  });
});

describe("syncCouponFromStripe (M3, F1, M5)", () => {
  const fullPreview = {
    lines: {
      has_more: false,
      data: [
        {
          amount: 9900,
          discount_amounts: [{ amount: 9900 }],
          parent: {
            type: "subscription_item_details",
            subscription_item_details: { proration: false },
          },
        },
      ],
    },
    total_discount_amounts: [{ amount: 9900 }],
  };
  const stripeFor = (
    h: ReturnType<typeof harness>,
    preview: any = fullPreview,
    sub: any = { status: "active", discounts: [{ source: { coupon: "cp_pilot" }, end: null }] },
  ) => ({
    retrieveSubscriptionWithDiscounts: jest.fn(async () => {
      h.order.push("stripe.retrieve");
      return sub;
    }),
    previewNextInvoice: jest.fn(async () => {
      h.order.push("stripe.preview");
      return preview;
    }),
  });

  it("retrieves + previews BEFORE and OUTSIDE any transaction, then writes through the single writer", async () => {
    const h = harness();
    const stripe = stripeFor(h);
    const out = await syncCouponFromStripe(
      { ...h, stripe },
      "t1",
      "sub_acme",
      "subscription_updated",
    );
    expect(out).toEqual({ outcome: "applied", full: true, amountDelta: -99 });
    expect(h.order.slice(0, 3)).toEqual(["stripe.retrieve", "stripe.preview", "tx.open"]);
    expect(h.row).toMatchObject({ couponFull: true, couponId: "cp_pilot" });
    expect(stripe.retrieveSubscriptionWithDiscounts).toHaveBeenCalledWith("sub_acme");
  });

  it("a failing retrieve or preview THROWS and writes nothing (the ledger records an error; Stripe retries)", async () => {
    const h = harness();
    const bad = stripeFor(h);
    bad.retrieveSubscriptionWithDiscounts.mockRejectedValue(new Error("Stripe timeout"));
    await expect(
      syncCouponFromStripe({ ...h, stripe: bad }, "t1", "sub_acme", "x"),
    ).rejects.toThrow("Stripe timeout");
    const bad2 = stripeFor(h);
    bad2.previewNextInvoice.mockRejectedValue(new Error("rate limited"));
    await expect(
      syncCouponFromStripe({ ...h, stripe: bad2 }, "t1", "sub_acme", "x"),
    ).rejects.toThrow("rate limited");
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(h.row.couponFull).toBe(false);
  });

  it("no upcoming invoice (preview null): the stored value is kept and nothing is written", async () => {
    const h = harness({ couponFull: true });
    const out = await syncCouponFromStripe(
      { ...h, stripe: stripeFor(h, null) },
      "t1",
      "sub_acme",
      "x",
    );
    expect(out).toEqual({ outcome: "skipped", why: "no_upcoming_invoice" });
    expect(h.row.couponFull).toBe(true);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a canceled subscription is not synced (the cancel path resets)", async () => {
    const h = harness({ couponFull: true });
    const out = await syncCouponFromStripe(
      { ...h, stripe: stripeFor(h, fullPreview, { status: "canceled", discounts: [] }) },
      "t1",
      "sub_acme",
      "x",
    );
    expect(out).toEqual({ outcome: "skipped", why: "ended" });
    expect(h.row.couponFull).toBe(true);
  });

  it("M5: externalPayment forces full = false - no Stripe call at all; a manual payer is billed by RF invoices", async () => {
    const h = harness({ externalPayment: true, couponFull: true });
    const stripe = stripeFor(h);
    const out = await syncCouponFromStripe({ ...h, stripe }, "t1", "sub_acme", "x");
    expect(out).toMatchObject({ outcome: "applied", full: false });
    expect(h.row.couponFull).toBe(false);
    expect(stripe.retrieveSubscriptionWithDiscounts).not.toHaveBeenCalled();
    expect(stripe.previewNextInvoice).not.toHaveBeenCalled();
  });

  it("a replaced subscription id or a missing row is skipped before any Stripe call", async () => {
    const h = harness({ stripeSubId: "sub_new" });
    const stripe = stripeFor(h);
    expect(await syncCouponFromStripe({ ...h, stripe }, "t1", "sub_old", "x")).toEqual({
      outcome: "skipped",
      why: "sub_changed",
    });
    h.prisma.tenantSubscription.findUnique.mockResolvedValue(null);
    expect(await syncCouponFromStripe({ ...h, stripe }, "t1", "sub_new", "x")).toEqual({
      outcome: "skipped",
      why: "no_row",
    });
    expect(stripe.retrieveSubscriptionWithDiscounts).not.toHaveBeenCalled();
  });

  it("a stale result (an older read) reports 'stale', not 'applied'", async () => {
    const h = harness({ couponSyncedAt: new Date(Date.now() + 60_000) });
    const out = await syncCouponFromStripe({ ...h, stripe: stripeFor(h) }, "t1", "sub_acme", "x");
    expect(out).toEqual({ outcome: "stale" });
  });
});

describe("structural pin: ONE writer of the coupon columns (L-223)", () => {
  const srcRoot = join(__dirname, "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".spec.ts")) files.push(full);
    }
  };
  walk(srcRoot);
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("only coupon-state.ts mentions the three informational columns (they are written nowhere else)", () => {
    const offenders = files.filter((f) => {
      // coupon-unbilled.ts only DEFINES the CouponState type and parses Stripe objects (no write).
      if (f.endsWith("coupon-state.ts") || f.endsWith("coupon-unbilled.ts")) return false;
      return /\bcoupon(SyncedAt|EndsAt|Id)\b/.test(strip(readFileSync(f, "utf8")));
    });
    expect(offenders.map((f) => f.slice(srcRoot.length))).toEqual([]);
  });

  it("couponFull is only ever WRITTEN by coupon-state.ts: every other use is a select, a literal where, or an allow-listed CAS", () => {
    const allowed = [
      /couponFull:\s*(true|false)\b/,
      /couponFull:\s*boolean\b/, // a type annotation
      /couponFull:\s*priorSub\.couponFull/,
    ];
    const bad: string[] = [];
    for (const f of files) {
      if (f.endsWith("coupon-state.ts") || f.endsWith("schema")) continue;
      const lines = strip(readFileSync(f, "utf8")).split("\n");
      lines.forEach((l, i) => {
        if (!/couponFull\s*:/.test(l)) return;
        if (allowed.some((re) => re.test(l))) return;
        bad.push(`${f.slice(srcRoot.length)}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(bad).toEqual([]);
  });

  it("no raw SQL writes the coupon columns", () => {
    const bad = files.filter((f) =>
      /UPDATE\s+"TenantSubscription"[^;]*coupon/i.test(readFileSync(f, "utf8")),
    );
    expect(bad).toEqual([]);
  });
});
