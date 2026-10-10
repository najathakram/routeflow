jest.mock("../common/db-locks", () => ({
  // the tenant-price lock around upgrade() is a pass-through here; its own spec covers it
  withAdvisoryLock: jest.fn(async (_o: unknown, fn: () => Promise<unknown>) => ({
    acquired: true as const,
    value: await fn(),
  })),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { ConflictException } from "@nestjs/common";
import { SubscriptionMutationService } from "./subscription-mutation.service";

/**
 * SA-733r7 PR-B3 (brief item 8): self-unpause is impossible. subscribe / upgrade / downgrade / resume refuse
 * 409 PAYMENT_OVERDUE (carrying hosted_invoice_url) while the owed marker is set - BEFORE the catalog is even
 * read - and a cancel while paused lands on READ_ONLY(subscription_cancelled). (The fifth route, checkout, is in
 * dunning-wiring.billing.spec.ts.)
 */

const OPEN = {
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

function make(
  o: {
    marker?: string | null;
    tenantStatus?: string;
    sub?: any;
    facts?: any;
    stripeThrows?: boolean;
  } = {},
) {
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    tenantSubscription: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma: any = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ status: o.tenantStatus ?? "READ_ONLY" }),
    },
    tenantSubscription: {
      findUnique: jest.fn().mockResolvedValue(
        o.sub ?? {
          pastDueInvoiceId: o.marker === undefined ? "in_1" : o.marker,
          stripeSubId: null,
        },
      ),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const catalog: any = {
    getPublishedCatalog: jest.fn().mockRejectedValue(new Error("must not be read")),
  };
  const stripe: any = {
    getInvoiceFacts: o.stripeThrows
      ? jest.fn().mockRejectedValue(new Error("down"))
      : jest.fn().mockResolvedValue(o.facts ?? OPEN),
    cancelSubscription: jest.fn().mockResolvedValue({}),
    getSubscription: jest.fn().mockResolvedValue({ status: "active" }),
    updateSubscription: jest.fn(),
  };
  const dunning: any = {
    markCancelledWhilePaused: jest.fn().mockResolvedValue(true),
    clearPauseAfterCommit: jest.fn(),
  };
  const svc = new SubscriptionMutationService(
    prisma,
    catalog,
    {} as any,
    {} as any,
    { invalidate: jest.fn() } as any,
    { emit: jest.fn() } as any,
    { invalidate: jest.fn() } as any,
    stripe,
    {} as any,
    {} as any,
    undefined,
    dunning,
  );
  return { svc, prisma, tx, catalog, stripe, dunning };
}

async function refusal(p: Promise<unknown>) {
  const e: any = await p.catch((x) => x);
  expect(e).toBeInstanceOf(ConflictException);
  return e.getResponse() as any;
}

describe("SubscriptionMutationService x dunning (SA-733r7 PR-B3)", () => {
  const saved = process.env.BILLING_PAUSE_MODE;
  beforeEach(() => {
    process.env.BILLING_PAUSE_MODE = "enforced";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.BILLING_PAUSE_MODE;
    else process.env.BILLING_PAUSE_MODE = saved;
  });

  const routes: [string, (s: SubscriptionMutationService) => Promise<unknown>][] = [
    [
      "subscribe",
      (s) => s.subscribe("t1", { planKey: "TEAM", cycle: "MONTHLY", addons: [] } as any, "u1"),
    ],
    ["upgrade", (s) => s.upgrade("t1", "TEAM", "u1")],
    ["downgrade", (s) => s.downgrade("t1", "STARTER", [], "u1")],
    ["resume", (s) => s.resume("t1", "u1")],
  ];

  it.each(routes)(
    "%s while pastDueInvoiceId is set -> 409 PAYMENT_OVERDUE carrying hosted_invoice_url, before anything else runs",
    async (_name, call) => {
      const d = make();
      const body = await refusal(call(d.svc));
      expect(body).toMatchObject({
        code: "PAYMENT_OVERDUE",
        hosted_invoice_url: "https://pay.example.test/i/in_1",
      });
      expect(d.catalog.getPublishedCatalog).not.toHaveBeenCalled();
      expect(d.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    "%s fails closed (409 PAYMENT_STATE_UNKNOWN) when Stripe cannot be read",
    async (_n, call) => {
      const d = make({ stripeThrows: true });
      expect((await refusal(call(d.svc))).code).toBe("PAYMENT_STATE_UNKNOWN");
      expect(d.catalog.getPublishedCatalog).not.toHaveBeenCalled();
    },
  );

  it.each(routes)("%s with no owed marker is not refused by the guard", async (_n, call) => {
    const d = make({ marker: null });
    const e: any = await call(d.svc).catch((x: unknown) => x);
    // it proceeds past the guard (and then trips on this harness's bare stubs, which is the point)
    const code = e instanceof ConflictException ? (e.getResponse() as any).code : null;
    expect(code).not.toBe("PAYMENT_OVERDUE");
    expect(code).not.toBe("PAYMENT_STATE_UNKNOWN");
    expect(d.stripe.getInvoiceFacts).not.toHaveBeenCalled();
  });

  describe("cancel while paused", () => {
    it("a paused tenant (READ_ONLY) with a live subscription: Stripe is cancelled immediately, THEN the tenant lands on subscription_cancelled", async () => {
      const d = make({ sub: { stripeSubId: "sub_1", pastDueInvoiceId: "in_1" } });
      d.prisma.tenant.findUnique.mockResolvedValue({ status: "READ_ONLY" });
      const out: any = await d.svc.cancel("t1", "u1");
      expect(out).toEqual({ cancelled: "already_read_only" });
      expect(d.stripe.cancelSubscription).toHaveBeenCalledWith("sub_1");
      expect(d.dunning.markCancelledWhilePaused).toHaveBeenCalledWith("t1");
      expect(d.stripe.cancelSubscription.mock.invocationCallOrder[0]).toBeLessThan(
        d.dunning.markCancelledWhilePaused.mock.invocationCallOrder[0],
      );
    });

    it("a repeat cancel (the subscription pointer already released) is still idempotent and never CANCELLED", async () => {
      const d = make({ sub: { stripeSubId: null, pastDueInvoiceId: "in_1" } });
      d.prisma.tenant.findUnique.mockResolvedValue({ status: "READ_ONLY" });
      const out: any = await d.svc.cancel("t1", "u1");
      expect(out).toEqual({ cancelled: "already_read_only" });
      expect(d.stripe.cancelSubscription).not.toHaveBeenCalled();
      expect(d.dunning.markCancelledWhilePaused).toHaveBeenCalledWith("t1");
    });

    it("a Stripe failure cancels nothing locally: the tenant stays paused (503, nothing written)", async () => {
      const d = make({ sub: { stripeSubId: "sub_1", pastDueInvoiceId: "in_1" } });
      d.prisma.tenant.findUnique.mockResolvedValue({ status: "READ_ONLY" });
      d.stripe.cancelSubscription.mockRejectedValue(new Error("down"));
      await expect(d.svc.cancel("t1", "u1")).rejects.toThrow(/did not confirm/);
      expect(d.dunning.markCancelledWhilePaused).not.toHaveBeenCalled();
    });
  });
});
