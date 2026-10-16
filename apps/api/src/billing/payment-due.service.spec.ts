import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PaymentDueService, isPastDue } from "./payment-due.service";

/**
 * The tenant-side "payment due" read and self-serve pay. The money comes from the SAME planner the super-admin
 * catch-up route uses (CatchupCheckoutService.plan); this service only decides whether it is a tenant's to pay,
 * whether a session is already open, and never takes an amount from a client.
 */
const NOW = new Date("2026-10-09T10:00:00Z");
const OCT_1 = new Date("2026-10-01T12:00:00Z");
const NOV_1 = new Date("2026-11-01T12:00:00Z");

function report(over: Record<string, unknown> = {}, stub: Record<string, unknown> = {}) {
  return {
    tenantId: "t1",
    slug: "acme",
    tenantClass: "PRODUCTION",
    tenantStatus: "ACTIVE",
    eligible: true,
    ineligible: [] as string[],
    plan: {
      ok: true,
      shape: "trial_one_time",
      anchorAt: NOV_1,
      trialEndAt: NOV_1,
      stub: {
        from: OCT_1,
        to: NOV_1,
        label: "October 2026 subscription",
        lines: [],
        totalCents: 31000,
        belowStripeMinimum: false,
        ...stub,
      },
    },
    ...over,
  };
}

function make(
  o: {
    report?: ReturnType<typeof report>;
    sub?: Record<string, unknown> | null;
    tz?: string | null;
    session?: Record<string, unknown> | null;
    now?: Date;
  } = {},
) {
  const catchup = {
    plan: jest.fn().mockResolvedValue(o.report ?? report()),
    open: jest.fn().mockResolvedValue({
      checkoutUrl: "https://checkout.stripe.test/new",
      sessionId: "cs_new",
      stubCents: 31000,
      shape: "trial_one_time",
    }),
  };
  const claim = { onSessionExpired: jest.fn().mockResolvedValue(undefined) };
  const stripe = {
    isConfigured: true,
    getCheckoutSession: jest.fn().mockResolvedValue(o.session ?? null),
  };
  const prisma = {
    // the zone lives on TenantConfig and is read through the single resolver (common/tenant-time-zone.ts)
    tenantConfig: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ timezone: o.tz === undefined ? "America/New_York" : o.tz }),
    },
    tenantSubscription: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          o.sub === undefined ? { catchupState: null, catchupSessionId: null } : o.sub,
        ),
    },
  };
  const svc = new PaymentDueService(prisma as any, catchup as any, claim as any, stripe as any);
  return { svc, catchup, claim, stripe, prisma };
}

describe("PaymentDueService.get", () => {
  it("is due with the planner's stub amount, month label and period start", async () => {
    const { svc, catchup } = make();
    const v = await svc.get("t1", NOW);
    expect(catchup.plan).toHaveBeenCalledWith("t1", NOW);
    expect(v).toEqual({
      due: true,
      pastDue: true,
      amountCents: 31000,
      periodLabel: "October 2026",
      periodStart: OCT_1.toISOString(),
    });
  });

  it("reads only the signed-in tenant's plan (never another id)", async () => {
    const { svc, catchup, prisma } = make();
    await svc.get("t-mine", NOW);
    expect(catchup.plan).toHaveBeenCalledTimes(1);
    expect(catchup.plan.mock.calls[0][0]).toBe("t-mine");
    expect(prisma.tenantConfig.findUnique.mock.calls[0][0].where).toEqual({ tenantId: "t-mine" });
  });

  it("is not due when the planner refuses (a blocker other than a held claim)", async () => {
    const { svc } = make({ report: report({ ineligible: ["has_stripe_subscription"] }) });
    expect((await svc.get("t1", NOW)).due).toBe(false);
  });

  it("is not due when the planner cannot plan", async () => {
    const { svc } = make({ report: report({ plan: { ok: false, reason: "paid_after_gap" } }) });
    expect((await svc.get("t1", NOW)).due).toBe(false);
  });

  it("is not due when the stub is zero or forgiven below the Stripe minimum", async () => {
    expect((await make({ report: report({}, { totalCents: 0 }) }).svc.get("t1", NOW)).due).toBe(
      false,
    );
    expect(
      (
        await make({ report: report({}, { totalCents: 30, belowStripeMinimum: true }) }).svc.get(
          "t1",
          NOW,
        )
      ).due,
    ).toBe(false);
  });

  it("is not due for a non-production tenant", async () => {
    const { svc } = make({ report: report({ tenantClass: "DEMO" }) });
    expect((await svc.get("t1", NOW)).due).toBe(false);
  });

  it("stays due while an open session holds the claim (claim_held is not a reason to hide the bill)", async () => {
    const { svc } = make({
      report: report({ eligible: false, ineligible: ["claim_held"], claimState: "SESSION_OPEN" }),
    });
    expect((await svc.get("t1", NOW)).due).toBe(true);
  });

  it("pastDue is false on the day the period starts and true the day after (tenant zone)", async () => {
    const onDay = await make().svc.get("t1", new Date("2026-10-01T16:00:00Z"));
    expect(onDay.pastDue).toBe(false);
    const after = await make().svc.get("t1", new Date("2026-10-02T16:00:00Z"));
    expect(after.pastDue).toBe(true);
  });

  it("a period that starts in the future is due but not past due", async () => {
    const { svc } = make({
      report: report(
        {},
        { from: new Date("2026-11-01T12:00:00Z"), to: new Date("2026-12-01T12:00:00Z") },
      ),
    });
    const v = await svc.get("t1", NOW);
    expect(v.due).toBe(true);
    expect(v.pastDue).toBe(false);
    expect(v.periodLabel).toBe("November 2026");
  });
});

describe("isPastDue", () => {
  it("compares calendar dates in the tenant's zone", () => {
    // 2026-10-02 02:00Z is still Oct 1 evening in New York, so an Oct 1 period has not started "before today"
    expect(isPastDue(OCT_1, new Date("2026-10-02T02:00:00Z"), "America/New_York")).toBe(false);
    expect(isPastDue(OCT_1, new Date("2026-10-02T02:00:00Z"), "UTC")).toBe(true);
  });
  it("falls back to UTC for no zone or a bad zone", () => {
    expect(isPastDue(OCT_1, new Date("2026-10-02T02:00:00Z"), null)).toBe(true);
    expect(isPastDue(OCT_1, new Date("2026-10-02T02:00:00Z"), "Not/AZone")).toBe(true);
  });
});

describe("PaymentDueService.pay", () => {
  it("refuses with 409 PAYMENT_NOT_DUE when nothing is due and creates nothing", async () => {
    const { svc, catchup } = make({ report: report({}, { totalCents: 0 }) });
    await expect(svc.pay("t1", NOW)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PAYMENT_NOT_DUE },
    });
    await expect(svc.pay("t1", NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(catchup.open).not.toHaveBeenCalled();
  });

  it("creates ONE session through the catch-up path, priced by the planner, returning to /settings/billing", async () => {
    process.env.FRONTEND_URL = "https://app.test";
    const { svc, catchup } = make();
    const out = await svc.pay("t1", NOW);
    expect(out).toEqual({ checkoutUrl: "https://checkout.stripe.test/new" });
    expect(catchup.open).toHaveBeenCalledTimes(1);
    expect(catchup.open).toHaveBeenCalledWith("t1", {
      expectedStubCents: 31000,
      now: NOW,
      successUrl: "https://app.test/settings/billing?paid=1",
      cancelUrl: "https://app.test/settings/billing?checkout=cancelled",
    });
  });

  it("takes no amount from the caller (the signature has none)", () => {
    const { svc } = make();
    expect(svc.pay.length).toBeLessThanOrEqual(2);
  });

  it("REUSES an open, unexpired session: no second create", async () => {
    const { svc, catchup, stripe } = make({
      sub: { catchupState: "SESSION_OPEN", catchupSessionId: "cs_open" },
      report: report({ eligible: false, ineligible: ["claim_held"] }),
      session: {
        id: "cs_open",
        status: "open",
        url: "https://checkout.stripe.test/open",
        expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
      },
    });
    const out = await svc.pay("t1", NOW);
    expect(out).toEqual({ checkoutUrl: "https://checkout.stripe.test/open" });
    expect(stripe.getCheckoutSession).toHaveBeenCalledWith("cs_open");
    expect(catchup.open).not.toHaveBeenCalled();
  });

  it("an expired stored session is released through the claim service, then a fresh one is created", async () => {
    const expired = {
      id: "cs_old",
      status: "expired",
      url: null,
      expires_at: Math.floor(NOW.getTime() / 1000) - 60,
    };
    const { svc, catchup, claim } = make({
      sub: { catchupState: "SESSION_OPEN", catchupSessionId: "cs_old" },
      report: report({ eligible: false, ineligible: ["claim_held"] }),
      session: expired,
    });
    const out = await svc.pay("t1", NOW);
    expect(claim.onSessionExpired).toHaveBeenCalledWith(expired);
    expect(catchup.open).toHaveBeenCalledTimes(1);
    expect(out.checkoutUrl).toBe("https://checkout.stripe.test/new");
  });

  it("a claim past SESSION_OPEN (payment settling) is refused with the claim's own 409, nothing created", async () => {
    const { svc, catchup } = make({
      sub: { catchupState: "AWAITING_FIRST_PAYMENT", catchupSessionId: "cs_done" },
      report: report({ eligible: false, ineligible: ["claim_held"] }),
    });
    await expect(svc.pay("t1", NOW)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_PENDING },
    });
    expect(catchup.open).not.toHaveBeenCalled();
  });

  it("a claim mid-creation (no session id yet) is refused as SESSION_OPEN, nothing created", async () => {
    const { svc, catchup } = make({
      sub: { catchupState: "SESSION_OPEN", catchupSessionId: null },
      report: report({ eligible: false, ineligible: ["claim_held"] }),
    });
    await expect(svc.pay("t1", NOW)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.CATCHUP_SESSION_OPEN },
    });
    expect(catchup.open).not.toHaveBeenCalled();
  });
});
