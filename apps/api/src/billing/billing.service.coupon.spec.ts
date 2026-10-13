// SA-736r: the Stripe webhook handlers + the coupon-unbilled state, against a STATEFUL fake (one in-memory
// tenant + subscription row, one append-only ledger), so every row asserts END state: the columns, the tenant
// status and the ledger SUM - never a call shape. Stripe is mocked at the StripeService boundary.
import { BillingService } from "./billing.service";

interface World {
  tenant: { status: string; class: string; deletedAt: Date | null };
  sub: Record<string, any>;
}

const PRICED = {
  lines: {
    has_more: false,
    data: [
      {
        amount: 9900,
        discount_amounts: [],
        parent: {
          type: "subscription_item_details",
          subscription_item_details: { proration: false },
        },
      },
    ],
  },
  total_discount_amounts: [],
};
const FULL = {
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

function build(init: { status?: string; sub?: Record<string, any> } = {}) {
  const w: World = {
    tenant: { status: init.status ?? "ACTIVE", class: "PRODUCTION", deletedAt: null },
    sub: {
      tenantId: "t1",
      planKey: "STARTER",
      basePriceSnapshot: 99,
      discount: 0,
      stripeSubId: "sub_1",
      stripeCustomerId: "cus_1",
      externalPayment: false,
      failedPaymentCount: 0,
      cancelAtPeriodEnd: false,
      downgradeToPlanKey: null,
      downgradeEffectiveAt: null,
      couponFull: false,
      couponId: null,
      couponEndsAt: null,
      couponSyncedAt: null,
      ...(init.sub ?? {}),
    },
  };
  const ledger: Array<{ type: string; amountDelta: number }> = [];
  const view = (select?: any) => ({
    ...w.sub,
    ...(select?.tenant || true
      ? { tenant: { id: "t1", slug: "acme", name: "Acme", ...w.tenant } }
      : {}),
  });
  const matchStatus = (cond: any): boolean => {
    if (cond === undefined) return true;
    if (typeof cond === "string") return w.tenant.status === cond;
    if (cond.not !== undefined) return w.tenant.status !== cond.not;
    return true;
  };
  const prisma: any = {
    tenant: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matchStatus(where.status)) return { count: 0 };
        Object.assign(w.tenant, data);
        return { count: 1 };
      }),
      findUniqueOrThrow: jest.fn(async () => ({ ...w.tenant })),
      // SA-775: cancelFromStripe reads the tenant's class + status for the automatic-lock gate.
      findUnique: jest.fn(async () => ({ id: "t1", ...w.tenant })),
    },
    tenantSubscription: {
      findFirst: jest.fn(async () => view()),
      findUnique: jest.fn(async ({ select }: any) => view(select)),
      update: jest.fn(async ({ data }: any) => {
        for (const [k, v] of Object.entries(data)) {
          w.sub[k] =
            v && typeof v === "object" && "increment" in (v as any)
              ? (w.sub[k] ?? 0) + (v as any).increment
              : v;
        }
        return view();
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if ("couponFull" in where && where.couponFull !== w.sub.couponFull) return { count: 0 };
        if (where.OR) {
          const ok = where.OR.some((c: any) =>
            c.couponSyncedAt === null
              ? w.sub.couponSyncedAt === null
              : w.sub.couponSyncedAt !== null &&
                w.sub.couponSyncedAt.getTime() < c.couponSyncedAt.lt.getTime(),
          );
          if (!ok) return { count: 0 };
        }
        Object.assign(w.sub, data);
        return { count: 1 };
      }),
    },
    tenantAddon: { findMany: jest.fn(async () => []) },
    user: { findFirst: jest.fn(async () => null) },
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 0),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const events: any = {
    emit: jest.fn(async (_t: string, type: string, _p: unknown, opts: any) => {
      ledger.push({ type, amountDelta: opts?.amountDelta ?? 0 });
    }),
  };
  const stripe: any = {
    isConfigured: true,
    getSubscription: jest.fn(async () => ({
      status: "active",
      customer: "cus_1",
      items: {
        data: [
          { id: "si_1", current_period_start: 1_700_000_000, current_period_end: 1_702_000_000 },
        ],
      },
    })),
    retrieveSubscriptionWithDiscounts: jest.fn(async () => ({
      id: "sub_1",
      status: "active",
      discounts: [{ source: { coupon: "cp_pilot" }, end: null }],
    })),
    previewNextInvoice: jest.fn(async () => PRICED),
    createBillingPortalSession: jest.fn(async () => ({ url: "https://billing.stripe.test/p/1" })),
  };
  const tenantStatus = { invalidate: jest.fn() };
  const billingNotification = {
    notifyCancelled: jest.fn(async () => undefined),
    notifySuspended: jest.fn(async () => undefined),
  };
  const svc = new (BillingService as any)(
    prisma,
    stripe,
    { send: jest.fn(async () => ({})) },
    tenantStatus,
    events,
    {},
    billingNotification,
    {},
    {},
  ) as BillingService;
  const sum = () => Math.round(ledger.reduce((s, e) => s + e.amountDelta, 0) * 100) / 100;
  return { svc: svc as any, w, prisma, stripe, events, ledger, sum };
}

const SUB_EVT = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  customer: "cus_1",
  status: "active",
  cancel_at_period_end: false,
  // the webhook PAYLOAD: unexpanded discount ids - never trusted
  discounts: ["di_1"],
  items: {
    data: [{ id: "si_1", current_period_start: 1_700_000_000, current_period_end: 1_702_000_000 }],
  },
  ...over,
});
const INVOICE = { customer: "cus_1", parent: { subscription_details: { subscription: "sub_1" } } };

describe("coupon-unbilled: customer.subscription.updated (M3: retrieve + preview, never the payload)", () => {
  it("a 100% coupon: couponFull, ONE -X event; a replay adds none; the retrieve is by id (the payload's discount ids are not trusted)", async () => {
    const h = build();
    h.stripe.previewNextInvoice.mockResolvedValue(FULL);
    await h.svc.onSubscriptionUpdated(SUB_EVT());
    expect(h.w.sub).toMatchObject({ couponFull: true, couponId: "cp_pilot" });
    expect(h.stripe.retrieveSubscriptionWithDiscounts).toHaveBeenCalledWith("sub_1");
    expect(h.stripe.previewNextInvoice).toHaveBeenCalledWith("sub_1");
    expect(h.ledger).toEqual([{ type: "coupon.unbilled", amountDelta: -99 }]);
    await h.svc.onSubscriptionUpdated(SUB_EVT());
    expect(h.ledger).toHaveLength(1);
  });

  it("the coupon removed (or ended at a renewal): couponFull false, ONE +X; the round trip nets to 0 (mrr == ledgerMrr)", async () => {
    const h = build();
    h.stripe.previewNextInvoice.mockResolvedValue(FULL);
    await h.svc.onSubscriptionUpdated(SUB_EVT());
    await new Promise((r) => setTimeout(r, 5)); // F4: the second read must START after the first's stamp
    h.stripe.previewNextInvoice.mockResolvedValue(PRICED);
    await h.svc.onSubscriptionUpdated(SUB_EVT());
    expect(h.w.sub.couponFull).toBe(false);
    expect(h.ledger.map((e) => e.amountDelta)).toEqual([-99, 99]);
    expect(h.sum()).toBe(0);
  });

  it("a 50% coupon, a 100% coupon restricted to one product, amount_off below the price: couponFull stays false", async () => {
    const h = build();
    const half = structuredClone(FULL);
    half.lines.data[0].discount_amounts = [{ amount: 4950 }];
    half.total_discount_amounts = [{ amount: 4950 }];
    h.stripe.previewNextInvoice.mockResolvedValue(half);
    await h.svc.onSubscriptionUpdated(SUB_EVT());
    expect(h.w.sub.couponFull).toBe(false);
    expect(h.ledger).toEqual([]);
  });

  it("a retrieve (or preview) failure THROWS, so the webhook ledger records an error and Stripe retries", async () => {
    const h = build();
    h.stripe.retrieveSubscriptionWithDiscounts.mockRejectedValue(new Error("Stripe timeout"));
    await expect(h.svc.onSubscriptionUpdated(SUB_EVT())).rejects.toThrow("Stripe timeout");
    const g = build();
    g.stripe.previewNextInvoice.mockRejectedValue(new Error("rate limited"));
    await expect(g.svc.onSubscriptionUpdated(SUB_EVT())).rejects.toThrow("rate limited");
  });

  it("a manual payer (externalPayment) keeps its stripeSubId but is never couponFull, whatever the preview says", async () => {
    const h = build({ sub: { externalPayment: true } });
    h.stripe.previewNextInvoice.mockResolvedValue(FULL);
    await h.svc.onSubscriptionUpdated(SUB_EVT());
    expect(h.w.sub.couponFull).toBe(false);
    expect(h.stripe.previewNextInvoice).not.toHaveBeenCalled();
    expect(h.ledger).toEqual([]);
  });
});

describe("coupon-unbilled: cancellation (M1, M5, F5) - C is value-red on master", () => {
  it("C: subscription.updated 'canceled' on a coupon tenant books 0 (master: -X) and resets all columns; no sync runs", async () => {
    const h = build({ sub: { couponFull: true, couponId: "cp_pilot", couponEndsAt: new Date(1) } });
    await h.svc.onSubscriptionUpdated(SUB_EVT({ status: "canceled" }));
    expect(h.w.tenant.status).toBe("CANCELLED");
    expect(h.sum()).toBe(0);
    expect(h.w.sub).toMatchObject({ couponFull: false, couponId: null, couponEndsAt: null });
    expect(h.stripe.retrieveSubscriptionWithDiscounts).not.toHaveBeenCalled();
    expect(h.stripe.previewNextInvoice).not.toHaveBeenCalled();
  });

  it("review nit: in the cancelled branch the reset runs AFTER the cancel-flag / downgrade-disarm write", async () => {
    const h = build({
      sub: { couponFull: true, couponId: "cp_pilot", downgradeToPlanKey: "GROWTH" },
    });
    const order: string[] = [];
    const realUpdate = h.prisma.tenantSubscription.update;
    h.prisma.tenantSubscription.update = jest.fn(async (a: any) => {
      if ("cancelAtPeriodEnd" in a.data) order.push("cancel-flag");
      return realUpdate(a);
    });
    const realMany = h.prisma.tenantSubscription.updateMany;
    h.prisma.tenantSubscription.updateMany = jest.fn(async (a: any) => {
      if ("couponFull" in a.data) order.push("coupon-reset");
      return realMany(a);
    });
    await h.svc.onSubscriptionDeleted({ id: "sub_1", customer: "cus_1" });
    expect(order).toEqual(["cancel-flag", "coupon-reset"]);
    expect(h.w.sub.downgradeToPlanKey).toBeNull();
  });

  it("customer.subscription.deleted on a coupon tenant: the same - books 0, columns reset", async () => {
    const h = build({ sub: { couponFull: true, couponId: "cp_pilot" } });
    await h.svc.onSubscriptionDeleted({ id: "sub_1", customer: "cus_1" });
    expect(h.sum()).toBe(0);
    expect(h.w.sub.couponFull).toBe(false);
  });

  it("a paying (non-coupon) tenant still books the churn -X exactly once", async () => {
    const h = build();
    await h.svc.onSubscriptionDeleted({ id: "sub_1", customer: "cus_1" });
    await h.svc.onSubscriptionDeleted({ id: "sub_1", customer: "cus_1" });
    expect(h.ledger.map((e) => e.amountDelta)).toEqual([-99]);
  });

  it("F5: a TRIAL / READ_ONLY row misses the status CAS but its coupon columns are STILL reset, booking 0", async () => {
    for (const status of ["READ_ONLY", "TRIAL"]) {
      const h = build({ status, sub: { couponFull: true, couponId: "cp" } });
      await h.svc.onSubscriptionDeleted({ id: "sub_1", customer: "cus_1" });
      expect(h.w.tenant.status).toBe(status);
      expect(h.w.sub).toMatchObject({ couponFull: false, couponId: null });
      expect(h.sum()).toBe(0);
    }
  });
});

describe("coupon-unbilled: reinstatement and dunning order (M1, F1)", () => {
  it("B: a coupon added while SUSPENDED, then reinstated by payment_succeeded: books 0 (master: +X)", async () => {
    const h = build({ status: "SUSPENDED", sub: { couponFull: true, couponId: "cp_pilot" } });
    h.stripe.previewNextInvoice.mockResolvedValue(FULL);
    await h.svc.onPaymentSucceeded(INVOICE);
    expect(h.w.tenant.status).toBe("ACTIVE");
    expect(h.sum()).toBe(0);
    expect(h.w.sub.couponFull).toBe(true);
  });

  it("A: SUSPENDED + couponFull, the coupon ended, then payment_succeeded: exactly +X (the reinstatement reads couponFull inside its tx; the sync books the exit)", async () => {
    const h = build({ status: "SUSPENDED", sub: { couponFull: true } });
    h.stripe.previewNextInvoice.mockResolvedValue(PRICED);
    await h.svc.onPaymentSucceeded(INVOICE);
    expect(h.w.tenant.status).toBe("ACTIVE");
    expect(h.w.sub.couponFull).toBe(false);
    expect(h.ledger.map((e) => e.amountDelta)).toEqual([99]);
  });

  it("F1: payment_succeeded syncs LAST - a throwing sync is retried without double-booking the reinstatement", async () => {
    const h = build({ status: "SUSPENDED", sub: { couponFull: true } });
    h.stripe.previewNextInvoice.mockRejectedValueOnce(new Error("Stripe 503"));
    await expect(h.svc.onPaymentSucceeded(INVOICE)).rejects.toThrow("Stripe 503");
    expect(h.w.tenant.status).toBe("ACTIVE"); // the idempotent CAS resume already happened
    expect(h.sum()).toBe(0); // couponFull was still true: 0 booked
    h.stripe.previewNextInvoice.mockResolvedValue(PRICED);
    await h.svc.onPaymentSucceeded(INVOICE); // the redelivery: CAS loses (already ACTIVE), the sync books the exit
    expect(h.ledger.map((e) => e.amountDelta)).toEqual([99]);
  });

  it("payment_failed on a coupon tenant whose repeating coupon ended: synced false, +X, clock stamped, then the count moves (master: stays couponFull, never dunned)", async () => {
    const h = build({ sub: { couponFull: true, couponId: "cp_pilot" } });
    h.stripe.previewNextInvoice.mockResolvedValue(PRICED);
    await h.svc.onPaymentFailed(INVOICE);
    expect(h.w.sub.couponFull).toBe(false);
    expect(h.w.sub.couponSyncedAt).toBeInstanceOf(Date);
    expect(h.ledger).toEqual([{ type: "coupon.billed", amountDelta: 99 }]);
    expect(h.w.sub.failedPaymentCount).toBe(1);
  });

  it("review nit: a payment_failed whose preview errors (anything but invoice_upcoming_none) logs an ERROR with the tenant id and rethrows", async () => {
    const h = build({ sub: { couponFull: true } });
    const errors: string[] = [];
    jest.spyOn((h.svc as any).logger, "error").mockImplementation((m: unknown) => {
      errors.push(String(m));
    });
    h.stripe.previewNextInvoice.mockRejectedValue(new Error("rate limited"));
    await expect(h.svc.onPaymentFailed(INVOICE)).rejects.toThrow("rate limited");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("tenant t1");
    expect(errors[0]).toContain("failed-payment count did not advance");
    expect(h.w.sub.failedPaymentCount).toBe(0);
  });

  it("F1: payment_failed syncs BEFORE the non-idempotent increment - a throwing sync leaves the count untouched, so the redelivery counts once", async () => {
    const h = build({ sub: { couponFull: true } });
    h.stripe.previewNextInvoice.mockRejectedValueOnce(new Error("Stripe 503"));
    await expect(h.svc.onPaymentFailed(INVOICE)).rejects.toThrow("Stripe 503");
    expect(h.w.sub.failedPaymentCount).toBe(0);
    h.stripe.previewNextInvoice.mockResolvedValue(PRICED);
    await h.svc.onPaymentFailed(INVOICE);
    expect(h.w.sub.failedPaymentCount).toBe(1);
  });
});

describe("coupon-unbilled: the ledger reads the in-tx row (M1)", () => {
  it("transitionAndEmit never uses a pre-tx sub: the reinstatement is priced from the row re-read after the status CAS", async () => {
    const h = build({ status: "SUSPENDED" });
    // the pre-tx scan (findFirst) still says couponFull=false, but a coupon sync lands before the CAS tx reads it
    const realFindFirst = h.prisma.tenantSubscription.findFirst;
    h.prisma.tenantSubscription.findFirst = jest.fn(async (a: any) => {
      const row = await realFindFirst(a);
      h.w.sub.couponFull = true; // the overtaking write, after the scan's read
      return { ...row, couponFull: false };
    });
    h.stripe.previewNextInvoice.mockResolvedValue(FULL);
    await h.svc.onPaymentSucceeded(INVOICE);
    expect(h.sum()).toBe(0); // master priced +X from the stale pre-tx row
  });
});

describe("coupon-unbilled: M5 - a replaced stripeSubId takes the old coupon columns with it", () => {
  it("resetCouponIfSubReplacedTx resets for a different previous id, books the in-tx before/after, and ignores a first/identical id", async () => {
    const h = build({ sub: { couponFull: true, couponId: "cp_old" } });
    await h.svc.resetCouponIfSubReplacedTx(h.prisma, "t1", "sub_old", "sub_new");
    expect(h.w.sub).toMatchObject({ couponFull: false, couponId: null });
    expect(h.ledger).toEqual([{ type: "coupon.billed", amountDelta: 99 }]);

    const same = build({ sub: { couponFull: true } });
    await same.svc.resetCouponIfSubReplacedTx(same.prisma, "t1", "sub_1", "sub_1");
    await same.svc.resetCouponIfSubReplacedTx(same.prisma, "t1", null, "sub_1");
    expect(same.w.sub.couponFull).toBe(true);
    expect(same.ledger).toEqual([]);
  });
});
