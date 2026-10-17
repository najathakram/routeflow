import { ConflictException, Logger, ServiceUnavailableException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { buildCatchupSessionParams } from "./catchup-session-params";
import { PaymentDueService, isPastDue } from "./payment-due.service";

/**
 * The tenant-side "payment due" read and self-serve pay. The money comes from the SAME planner the super-admin
 * catch-up route uses (CatchupCheckoutService.plan); this service only decides whether it is a tenant's to pay,
 * whether a session is already open, and never takes an amount from a client.
 */
const NOW = new Date("2026-10-09T10:00:00Z");
const OCT_1 = new Date("2026-10-01T12:00:00Z");
const NOV_1 = new Date("2026-11-01T12:00:00Z");
/** SA-806: D = A - 72 h, the planner's own `termsHoldUntil` (a mock plan carries it, the service never derives it). */
const OCT_29 = new Date("2026-10-29T12:00:00Z");

/**
 * Row 542d / SA-800c: the terms metadata the REAL session builder writes for a mock plan (including the full-terms
 * signature), so a stored session in these specs is exactly what `open()` would have created for that plan.
 */
function termsMeta(rep: ReturnType<typeof report>) {
  const m = buildCatchupSessionParams({
    tenantId: "t1",
    slug: "acme",
    planKey: "GROWTH",
    customerId: "cus_1",
    planPriceData: rep._inputs.planPriceData,
    addonLines: rep._inputs.addonLines,
    addonSkus: rep._inputs.addonSkus,
    plan: rep.plan as any,
    now: NOW,
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no",
  }).metadata;
  return {
    catchup_shape: m.catchup_shape,
    catchup_stub_cents: m.catchup_stub_cents,
    catchup_from: m.catchup_from,
    catchup_to: m.catchup_to,
    catchup_terms_sig: m.catchup_terms_sig,
  } as Record<string, string>;
}
/** `report()` = trial_one_time, a $310.00 October stub, A = Nov 1; `trialReport()` = the stub-free trial. */
const TERMS_META = termsMeta(report());
const TRIAL_TERMS_META = termsMeta(trialReport());

function report(over: Record<string, unknown> = {}, stub: Record<string, unknown> = {}) {
  return {
    tenantId: "t1",
    slug: "acme",
    planKey: "GROWTH",
    _inputs: {
      planPriceData: {
        currency: "usd",
        unit_amount: 31000,
        recurring: { interval: "month" },
        product_data: { name: "RouteFlow Growth" },
      } as Record<string, any>,
      addonLines: [] as any[],
      addonSkus: [] as string[],
    },
    tenantClass: "PRODUCTION",
    tenantStatus: "ACTIVE",
    eligible: true,
    ineligible: [] as string[],
    plan: {
      ok: true,
      shape: "trial_one_time",
      anchorAt: NOV_1,
      trialEndAt: NOV_1,
      termsHoldUntil: OCT_29,
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

/** The stub-free `trial` shape (S === A, a $0 stub): paid through the 1st the card starts billing on. */
function trialReport(over: Record<string, unknown> = {}) {
  const r = report(over, {
    from: NOV_1,
    to: NOV_1,
    totalCents: 0,
    label: "November 2026 subscription",
  });
  (r.plan as Record<string, unknown>).shape = "trial";
  return r;
}

function make(
  o: {
    report?: ReturnType<typeof report>;
    sub?: Record<string, unknown> | null;
    tz?: string | null;
    session?: Record<string, unknown> | null;
    /** Stripe's reply to expire(); an Error rejects. */
    expired?: Record<string, unknown> | null | Error;
    /** The session read rejects with this. */
    readError?: Error;
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
    getCheckoutSession: o.readError
      ? jest.fn().mockRejectedValue(o.readError)
      : jest.fn().mockResolvedValue(o.session ?? null),
    expireCheckoutSession:
      o.expired instanceof Error
        ? jest.fn().mockRejectedValue(o.expired)
        : jest.fn().mockResolvedValue(o.expired ?? null),
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
      cardNeeded: false,
      chargeStartsOn: null,
      cardBy: null,
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
  it("compares calendar dates in the (already resolved) zone", () => {
    // 2026-10-02 02:00Z is still Oct 1 evening in New York, so an Oct 1 period has not started "before today"
    expect(isPastDue(OCT_1, new Date("2026-10-02T02:00:00Z"), "America/New_York")).toBe(false);
    expect(isPastDue(OCT_1, new Date("2026-10-02T02:00:00Z"), "UTC")).toBe(true);
  });
});

describe("PaymentDueService.get: the zone is the single resolver's (UTC for none or a bad zone)", () => {
  const LATE_OCT_1_NY = new Date("2026-10-02T02:00:00Z");
  it("uses the tenant's zone", async () => {
    expect((await make().svc.get("t1", LATE_OCT_1_NY)).pastDue).toBe(false);
  });
  it.each([
    ["no zone", null],
    ["a bad zone", "Not/AZone"],
  ])("falls back to UTC for %s", async (_label, tz) => {
    expect((await make({ tz }).svc.get("t1", LATE_OCT_1_NY)).pastDue).toBe(true);
  });
});

describe("PaymentDueService.pay", () => {
  it("refuses with 409 PAYMENT_NOT_DUE when nothing is due and creates nothing", async () => {
    const { svc, catchup } = make({ report: report({ ineligible: ["has_stripe_subscription"] }) });
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
    // PATHS: open() joins them to its one FRONTEND_URL base
    expect(catchup.open).toHaveBeenCalledWith("t1", {
      expectedStubCents: 31000,
      now: NOW,
      successPath: "/settings/billing?paid=1",
      cancelPath: "/settings/billing?checkout=cancelled",
    });
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
        metadata: TERMS_META,
      },
    });
    const out = await svc.pay("t1", NOW);
    expect(out).toEqual({ checkoutUrl: "https://checkout.stripe.test/open" });
    expect(stripe.getCheckoutSession).toHaveBeenCalledWith("cs_open");
    expect(catchup.open).not.toHaveBeenCalled();
  });

  describe("F2: the stored session is read, and Stripe is told before anything is released", () => {
    const PAST = Math.floor(NOW.getTime() / 1000) - 60;
    const META = { tenantId: "t1", catchup: "1", ...TERMS_META };
    const held = {
      sub: { catchupState: "SESSION_OPEN", catchupSessionId: "cs_old" },
      report: report({ eligible: false, ineligible: ["claim_held"] }),
    };
    const staleOpen = {
      id: "cs_old",
      status: "open",
      url: "https://checkout.stripe.test/stale",
      expires_at: PAST,
      metadata: META,
    };
    const expiredReply = { id: "cs_old", status: "expired", url: null, metadata: META };
    const completeReply = { id: "cs_old", status: "complete", metadata: META };

    async function unknownState(h: ReturnType<typeof make>) {
      const err = await h.svc.pay("t1", NOW).catch((e) => e);
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err.getResponse() as { code: string }).code).toBe(
        API_ERROR_CODES.PAYMENT_STATE_UNKNOWN,
      );
      expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
      expect(h.catchup.open).not.toHaveBeenCalled();
    }

    it("a session Stripe already reports expired is released, then exactly ONE fresh session is created", async () => {
      const expired = { id: "cs_old", status: "expired", url: null, expires_at: PAST };
      const h = make({ ...held, session: expired });
      const out = await h.svc.pay("t1", NOW);
      expect(h.claim.onSessionExpired).toHaveBeenCalledTimes(1);
      expect(h.claim.onSessionExpired).toHaveBeenCalledWith(expired);
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
      expect(h.catchup.open).toHaveBeenCalledTimes(1);
      expect(out.checkoutUrl).toBe("https://checkout.stripe.test/new");
    });

    it("OPEN but past its expires_at: Stripe is told to expire it; on 'expired' the claim is released and ONE new session is created", async () => {
      const h = make({ ...held, session: staleOpen, expired: expiredReply });
      const out = await h.svc.pay("t1", NOW);
      expect(h.stripe.expireCheckoutSession).toHaveBeenCalledTimes(1);
      expect(h.stripe.expireCheckoutSession).toHaveBeenCalledWith("cs_old");
      expect(h.claim.onSessionExpired).toHaveBeenCalledTimes(1);
      expect(h.claim.onSessionExpired).toHaveBeenCalledWith(expiredReply);
      expect(h.catchup.open).toHaveBeenCalledTimes(1);
      expect(out.checkoutUrl).toBe("https://checkout.stripe.test/new");
    });

    it("OPEN with NO url is the same: expired at Stripe first, then released, then ONE new session", async () => {
      const noUrl = { ...staleOpen, url: null, expires_at: PAST + 7200 };
      const h = make({ ...held, session: noUrl, expired: expiredReply });
      await h.svc.pay("t1", NOW);
      expect(h.stripe.expireCheckoutSession).toHaveBeenCalledWith("cs_old");
      expect(h.claim.onSessionExpired).toHaveBeenCalledTimes(1);
      expect(h.catchup.open).toHaveBeenCalledTimes(1);
    });

    it("the release happens only AFTER Stripe confirmed the expiry (call order)", async () => {
      const h = make({ ...held, session: staleOpen, expired: expiredReply });
      const order: string[] = [];
      h.stripe.expireCheckoutSession.mockImplementation(async () => {
        order.push("stripe.expire");
        return expiredReply;
      });
      h.claim.onSessionExpired.mockImplementation(async () => {
        order.push("claim.release");
      });
      h.catchup.open.mockImplementation(async () => {
        order.push("open");
        return { checkoutUrl: "https://checkout.stripe.test/new" };
      });
      await h.svc.pay("t1", NOW);
      expect(order).toEqual(["stripe.expire", "claim.release", "open"]);
    });

    it("the read says COMPLETE: refused AWAITING_FIRST_PAYMENT (the claim's 409), no expire, no release, no session", async () => {
      const h = make({ ...held, session: { ...staleOpen, status: "complete" } });
      await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.CATCHUP_PENDING },
      });
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
      expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
      expect(h.catchup.open).not.toHaveBeenCalled();
    });

    it("the expire reply says COMPLETE (paid in the gap): same refusal, no release, ZERO sessions created", async () => {
      const h = make({ ...held, session: staleOpen, expired: completeReply });
      await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.CATCHUP_PENDING },
      });
      expect(h.stripe.expireCheckoutSession).toHaveBeenCalledTimes(1);
      expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
      expect(h.catchup.open).not.toHaveBeenCalled();
    });

    it("any other expire reply status is the complete branch (never a release)", async () => {
      const h = make({ ...held, session: staleOpen, expired: { id: "cs_old", status: "open" } });
      await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.CATCHUP_PENDING },
      });
      expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
      expect(h.catchup.open).not.toHaveBeenCalled();
    });

    it("expire() rejected (ECONNRESET) and the re-read still says open: a retryable 503 PAYMENT_STATE_UNKNOWN, nothing released, nothing created", async () => {
      await unknownState(make({ ...held, session: staleOpen, expired: new Error("ECONNRESET") }));
    });

    // Stripe REJECTS expire() on a session that is no longer open (paid in the gap): re-read once and decide.
    describe("expire() REJECTED: the session is re-read once", () => {
      const rejected = () => new Error("This Checkout Session is not in an open state.");
      const twoReads = (second: unknown) => {
        const h = make({ ...held, session: staleOpen, expired: rejected() });
        h.stripe.getCheckoutSession
          .mockReset()
          .mockResolvedValueOnce(staleOpen)
          .mockImplementationOnce(async () => {
            if (second instanceof Error) throw second;
            return second;
          });
        return h;
      };

      it("re-read says COMPLETE (paid in the gap): the claim's AWAITING_FIRST_PAYMENT 409, no release, no session", async () => {
        const h = twoReads({ ...staleOpen, status: "complete" });
        await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject({
          response: { code: API_ERROR_CODES.CATCHUP_PENDING },
        });
        expect(h.stripe.getCheckoutSession).toHaveBeenCalledTimes(2);
        expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
        expect(h.catchup.open).not.toHaveBeenCalled();
      });

      it("re-read says EXPIRED: released with the re-read session, then exactly ONE fresh session", async () => {
        const expired = { id: "cs_old", status: "expired", url: null, metadata: META };
        const h = twoReads(expired);
        const out = await h.svc.pay("t1", NOW);
        expect(out).toEqual({ checkoutUrl: "https://checkout.stripe.test/new" });
        expect(h.claim.onSessionExpired).toHaveBeenCalledWith(expired);
        expect(h.catchup.open).toHaveBeenCalledTimes(1);
      });

      it("re-read still OPEN: a 503, nothing released, nothing created", async () => {
        await unknownState(twoReads(staleOpen));
      });

      it("the re-read itself fails: a 503, nothing released, nothing created", async () => {
        await unknownState(twoReads(new Error("ETIMEDOUT")));
      });
    });

    it("an unusable expire reply (null) is a 503: nothing released, nothing created", async () => {
      await unknownState(make({ ...held, session: staleOpen, expired: null }));
    });

    it("a null session read is a 503: nothing touched (no expire, no release, no session)", async () => {
      const h = make({ ...held, session: null });
      await unknownState(h);
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
    });

    it("a session of an unknown status is a 503: nothing touched", async () => {
      const h = make({ ...held, session: { id: "cs_old", status: "weird" } });
      await unknownState(h);
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
    });

    it("a network error on the session read is a 503: nothing touched", async () => {
      const h = make({ ...held, readError: new Error("ETIMEDOUT") });
      await unknownState(h);
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
    });

    it("an open, unexpired session with a url is still reused as is (no expire)", async () => {
      const live = { ...staleOpen, expires_at: Math.floor(NOW.getTime() / 1000) + 600 };
      const h = make({ ...held, session: live });
      expect(await h.svc.pay("t1", NOW)).toEqual({ checkoutUrl: live.url });
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
      expect(h.catchup.open).not.toHaveBeenCalled();
    });
  });

  describe("F3: a parallel click that won the claim hands back ITS session", () => {
    const raced = {
      id: "cs_raced",
      status: "open",
      url: "https://checkout.stripe.test/raced",
      expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
      metadata: TERMS_META,
    };
    const lostRace: Array<[string, () => ConflictException]> = [
      [
        "CATCHUP_SESSION_OPEN",
        () => new ConflictException({ code: API_ERROR_CODES.CATCHUP_SESSION_OPEN, message: "x" }),
      ],
      [
        "CATCHUP_NOT_ELIGIBLE with reasons exactly [claim_held]",
        () =>
          new ConflictException({
            code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE,
            message: "This tenant is not eligible for a catch-up checkout. Nothing was created.",
            reasons: ["claim_held"],
          }),
      ],
    ];

    it.each(lostRace)("%s: the raced session url is returned, no second create", async (_l, mk) => {
      const h = make({ session: raced });
      // first read: no claim yet; the racer claims during open(); the second read finds its session
      h.prisma.tenantSubscription.findUnique
        .mockResolvedValueOnce({ catchupState: null, catchupSessionId: null })
        .mockResolvedValue({ catchupState: "SESSION_OPEN", catchupSessionId: "cs_raced" });
      h.catchup.open.mockRejectedValueOnce(mk());
      const out = await h.svc.pay("t1", NOW);
      expect(out).toEqual({ checkoutUrl: raced.url });
      expect(h.catchup.open).toHaveBeenCalledTimes(1);
    });

    it.each(lostRace)(
      "%s: a raced session that cannot be read is a retryable 503, never the operator wording",
      async (_l, mk) => {
        const h = make({ session: raced });
        // the racer's claim is not readable yet (no session id stored): the second read finds nothing usable
        h.prisma.tenantSubscription.findUnique
          .mockResolvedValueOnce({ catchupState: null, catchupSessionId: null })
          .mockResolvedValue({ catchupState: null, catchupSessionId: null });
        h.catchup.open.mockRejectedValueOnce(mk());
        await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject({
          response: { code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN },
        });
        expect(h.catchup.open).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      [
        "CATCHUP_NOT_ELIGIBLE with another reason alongside",
        new ConflictException({
          code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE,
          message: "x",
          reasons: ["claim_held", "tenant_not_active"],
        }),
      ],
      [
        "CATCHUP_NOT_ELIGIBLE for another reason",
        new ConflictException({
          code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE,
          message: "x",
          reasons: ["not_manual_invoicing"],
        }),
      ],
      [
        "CATCHUP_NOT_ELIGIBLE with no reasons",
        new ConflictException({ code: API_ERROR_CODES.CATCHUP_NOT_ELIGIBLE, message: "x" }),
      ],
    ])("%s is NOT a lost race: rethrown, the raced session is not read", async (_l, err) => {
      const h = make({ session: raced });
      h.catchup.open.mockRejectedValueOnce(err);
      await expect(h.svc.pay("t1", NOW)).rejects.toBe(err);
      expect(h.stripe.getCheckoutSession).not.toHaveBeenCalled();
    });
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

describe("SA-801: PaymentDueService.get, the card reminder for a stub-free catch-up", () => {
  it("a trial-shape tenant: due stays false, cardNeeded is true, chargeStartsOn is A (the ISO instant)", async () => {
    const { svc } = make({ report: trialReport() });
    expect(await svc.get("t1", NOW)).toEqual({
      due: false,
      pastDue: false,
      amountCents: 0,
      periodLabel: null,
      periodStart: null,
      cardNeeded: true,
      chargeStartsOn: NOV_1.toISOString(),
      cardBy: OCT_29.toISOString(),
    });
  });

  it("the money tenant (trial_one_time, a stub) is due and does NOT need the reminder", async () => {
    const v = await make().svc.get("t1", NOW);
    expect(v).toMatchObject({ due: true, cardNeeded: false, chargeStartsOn: null, cardBy: null });
  });

  it("SA-806 R4: a forgiven stub (under $0.50) is nothing charged now: cardNeeded true, due false, with A and D", async () => {
    const forgiven = make({ report: report({}, { totalCents: 30, belowStripeMinimum: true }) });
    expect(await forgiven.svc.get("t1", NOW)).toEqual({
      due: false,
      pastDue: false,
      amountCents: 0,
      periodLabel: null,
      periodStart: null,
      cardNeeded: true,
      chargeStartsOn: NOV_1.toISOString(),
      cardBy: OCT_29.toISOString(),
    });
  });

  it("every other not-due read carries cardNeeded:false, chargeStartsOn:null and cardBy:null", async () => {
    const noPlan = make({ report: report({ plan: { ok: false, reason: "paid_after_gap" } }) });
    expect(await noPlan.svc.get("t1", NOW)).toMatchObject({
      cardNeeded: false,
      chargeStartsOn: null,
      cardBy: null,
    });
  });

  it.each([
    [
      "an app-trial tenant (status TRIAL)",
      { tenantStatus: "TRIAL", ineligible: ["tenant_not_active"] },
    ],
    ["a READ_ONLY tenant", { tenantStatus: "READ_ONLY", ineligible: ["tenant_not_active"] }],
    ["a tenant with a Stripe subscription", { ineligible: ["has_stripe_subscription"] }],
    ["a tenant not on manual invoicing", { ineligible: ["not_manual_invoicing"] }],
    ["a tenant with no subscription row", { ineligible: ["no_subscription_row"] }],
    ["an unplaceable open invoice", { ineligible: ["unplaceable_open_invoice"] }],
    ["a DEMO tenant", { tenantClass: "DEMO" }],
    ["a TEST tenant", { tenantClass: "TEST" }],
  ])("%s gets no reminder", async (_name, over) => {
    const v = await make({ report: trialReport(over) }).svc.get("t1", NOW);
    expect(v).toMatchObject({ due: false, cardNeeded: false, chargeStartsOn: null, cardBy: null });
  });

  it("a plan that cannot be made gets no reminder", async () => {
    const r = trialReport({ plan: { ok: false, reason: "paid_after_gap" } });
    expect((await make({ report: r }).svc.get("t1", NOW)).cardNeeded).toBe(false);
  });

  it("an open session (claim_held) does not hide the reminder, exactly as it does not hide a bill", async () => {
    const r = trialReport({ eligible: false, ineligible: ["claim_held"] });
    expect(await make({ report: r }).svc.get("t1", NOW)).toMatchObject({
      cardNeeded: true,
      chargeStartsOn: NOV_1.toISOString(),
      cardBy: OCT_29.toISOString(),
    });
  });
});

describe("SA-801: PaymentDueService.pay for a card-needed tenant", () => {
  it("opens ONE session through the same open() with expectedStubCents 0 (nothing charged now)", async () => {
    const { svc, catchup } = make({ report: trialReport() });
    const out = await svc.pay("t1", NOW);
    expect(out).toEqual({ checkoutUrl: "https://checkout.stripe.test/new" });
    expect(catchup.open).toHaveBeenCalledTimes(1);
    expect(catchup.open).toHaveBeenCalledWith("t1", {
      expectedStubCents: 0,
      now: NOW,
      successPath: "/settings/billing?paid=1&card=1",
      cancelPath: "/settings/billing?checkout=cancelled",
    });
  });

  it("SA-806 R4: a forgiven stub passes the PLANNER's own stub total (30), never the view's 0 and never a client value", async () => {
    const { svc, catchup } = make({
      report: report({}, { totalCents: 30, belowStripeMinimum: true }),
    });
    await svc.pay("t1", NOW);
    expect(catchup.plan).toHaveBeenCalledTimes(1); // one read decides eligibility AND the expected amount
    expect(catchup.open).toHaveBeenCalledWith("t1", {
      expectedStubCents: 30,
      now: NOW,
      successPath: "/settings/billing?paid=1&card=1",
      cancelPath: "/settings/billing?checkout=cancelled",
    });
  });

  it("a real payment keeps the payment return path (paid=1 alone)", async () => {
    const { svc, catchup } = make();
    await svc.pay("t1", NOW);
    expect(catchup.open.mock.calls[0][1]).toMatchObject({
      expectedStubCents: 31000,
      successPath: "/settings/billing?paid=1",
    });
  });

  it("a second click REUSES the open, unexpired session: no second create", async () => {
    const { svc, catchup, stripe } = make({
      sub: { catchupState: "SESSION_OPEN", catchupSessionId: "cs_open" },
      report: trialReport({ eligible: false, ineligible: ["claim_held"] }),
      session: {
        id: "cs_open",
        status: "open",
        url: "https://checkout.stripe.test/open",
        expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
        metadata: TRIAL_TERMS_META,
      },
    });
    expect(await svc.pay("t1", NOW)).toEqual({ checkoutUrl: "https://checkout.stripe.test/open" });
    expect(stripe.getCheckoutSession).toHaveBeenCalledWith("cs_open");
    expect(catchup.open).not.toHaveBeenCalled();
  });

  it("the SA-800a release rule holds: Stripe confirms the expiry, then the claim is released, then ONE new session", async () => {
    const { svc, catchup, claim, stripe } = make({
      sub: { catchupState: "SESSION_OPEN", catchupSessionId: "cs_old" },
      report: trialReport({ eligible: false, ineligible: ["claim_held"] }),
      session: { id: "cs_old", status: "open", url: "https://x", expires_at: 1 },
      expired: { id: "cs_old", status: "expired" },
    });
    await svc.pay("t1", NOW);
    expect(stripe.expireCheckoutSession).toHaveBeenCalledWith("cs_old");
    expect(claim.onSessionExpired).toHaveBeenCalledTimes(1);
    expect(catchup.open).toHaveBeenCalledTimes(1);
  });

  it("a payment already settling (complete) is the claim's 409: no release, no session", async () => {
    const { svc, catchup, claim } = make({
      sub: { catchupState: "SESSION_OPEN", catchupSessionId: "cs_done" },
      report: trialReport({ eligible: false, ineligible: ["claim_held"] }),
      session: { id: "cs_done", status: "complete" },
    });
    await expect(svc.pay("t1", NOW)).rejects.toBeInstanceOf(ConflictException);
    expect(claim.onSessionExpired).not.toHaveBeenCalled();
    expect(catchup.open).not.toHaveBeenCalled();
  });

  it("an unreadable session is a retryable 503: nothing released or created", async () => {
    const { svc, catchup, claim } = make({
      sub: { catchupState: "SESSION_OPEN", catchupSessionId: "cs_x" },
      report: trialReport({ eligible: false, ineligible: ["claim_held"] }),
      readError: new Error("network"),
    });
    await expect(svc.pay("t1", NOW)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(claim.onSessionExpired).not.toHaveBeenCalled();
    expect(catchup.open).not.toHaveBeenCalled();
  });

  it("neither due nor card-needed (TRIAL status, READ_ONLY, Stripe sub): 409 PAYMENT_NOT_DUE, nothing created", async () => {
    for (const over of [
      { tenantStatus: "TRIAL", ineligible: ["tenant_not_active"] },
      { tenantStatus: "READ_ONLY", ineligible: ["tenant_not_active"] },
      { ineligible: ["has_stripe_subscription"] },
    ]) {
      const { svc, catchup } = make({ report: trialReport(over) });
      await expect(svc.pay("t1", NOW)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.PAYMENT_NOT_DUE },
      });
      expect(catchup.open).not.toHaveBeenCalled();
    }
  });
});

/**
 * Row 542d: a LIVE open session is reused only when the terms it was built with (stub cents, shape, S = catchup_from,
 * A = catchup_to) equal the fresh plan's. Otherwise it is stale and takes the SAME expire path as a dead one (SA-800a
 * MED-2): Stripe confirms `expired` first, only then the claim is released and ONE new session is created; a session
 * that completed first is the claim's AWAITING_FIRST_PAYMENT, never a second session.
 */
describe("542d: a live session whose terms differ from the fresh plan is stale", () => {
  const LIVE_UNTIL = Math.floor(NOW.getTime() / 1000) + 3600;
  const held = {
    sub: { catchupState: "SESSION_OPEN", catchupSessionId: "cs_old" },
    report: report({ eligible: false, ineligible: ["claim_held"] }),
  };
  const live = (metadata: Record<string, unknown> | undefined) => ({
    id: "cs_old",
    status: "open",
    url: "https://checkout.stripe.test/old",
    expires_at: LIVE_UNTIL,
    ...(metadata === undefined ? {} : { metadata }),
  });
  const T = { tenantId: "t1", catchup: "period" };
  /** The card-add session of the Oct 29 scenario against the fresh bill plan of `report()`. */
  const OLD_CARD_ADD = { ...T, ...TRIAL_TERMS_META };
  const expiredReply = { id: "cs_old", status: "expired", url: null, metadata: { ...T } };
  const completeReply = { id: "cs_old", status: "complete", metadata: { ...T } };
  const rejected = () => new Error("This Checkout Session is not in an open state.");

  async function expect503(h: ReturnType<typeof make>) {
    const err = await h.svc.pay("t1", NOW).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err.getResponse() as { code: string }).code).toBe(
      API_ERROR_CODES.PAYMENT_STATE_UNKNOWN,
    );
    expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
    expect(h.catchup.open).not.toHaveBeenCalled();
  }

  describe("row 1/2: a mismatch takes the expire path, then ONE new session", () => {
    it.each([
      ["a $0 card-add session against a stub bill (Oct 29)", OLD_CARD_ADD],
      [
        "a stale 'Pay $X' whose stub cents differ",
        { ...T, ...TERMS_META, catchup_stub_cents: "40000" },
      ],
      ["the shape differs, the rest equal", { ...T, ...TERMS_META, catchup_shape: "trial" }],
      [
        "SA-800c: every metadata term equal but the signed terms differ (the recurring price changed)",
        {
          ...T,
          ...termsMeta(
            report({
              _inputs: {
                planPriceData: {
                  currency: "usd",
                  unit_amount: 10000,
                  recurring: { interval: "month" },
                },
                addonLines: [],
                addonSkus: [],
              },
            }),
          ),
        },
      ],
      ["catchup_to (A) differs", { ...T, ...TERMS_META, catchup_to: "2026-12-01T12:00:00.000Z" }],
      [
        "catchup_from (S) differs",
        { ...T, ...TERMS_META, catchup_from: "2026-09-01T12:00:00.000Z" },
      ],
    ])("%s: Stripe expires it, the claim is released AFTER, then open() once", async (_n, meta) => {
      const h = make({ ...held, session: live(meta), expired: expiredReply });
      const order: string[] = [];
      h.stripe.expireCheckoutSession.mockImplementation(async () => {
        order.push("stripe.expire");
        return expiredReply;
      });
      h.claim.onSessionExpired.mockImplementation(async () => {
        order.push("claim.release");
      });
      h.catchup.open.mockImplementation(async () => {
        order.push("open");
        return { checkoutUrl: "https://checkout.stripe.test/new" };
      });
      const out = await h.svc.pay("t1", NOW);
      expect(out).toEqual({ checkoutUrl: "https://checkout.stripe.test/new" });
      expect(order).toEqual(["stripe.expire", "claim.release", "open"]);
      expect(h.stripe.expireCheckoutSession).toHaveBeenCalledWith("cs_old");
      expect(h.claim.onSessionExpired).toHaveBeenCalledWith(expiredReply);
      // the new session is priced by the planner's own read, exactly as before
      expect(h.catchup.open).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ expectedStubCents: 31000 }),
      );
    });

    it("the reverse: an old 'Pay $X' session against a fresh card-add plan", async () => {
      const h = make({
        sub: held.sub,
        report: trialReport({ eligible: false, ineligible: ["claim_held"] }),
        session: live({ ...T, ...TERMS_META }),
        expired: expiredReply,
      });
      const out = await h.svc.pay("t1", NOW);
      expect(out.checkoutUrl).toBe("https://checkout.stripe.test/new");
      expect(h.stripe.expireCheckoutSession).toHaveBeenCalledTimes(1);
      expect(h.claim.onSessionExpired).toHaveBeenCalledTimes(1);
      expect(h.catchup.open).toHaveBeenCalledTimes(1);
      expect(h.catchup.open.mock.calls[0][1]).toMatchObject({
        expectedStubCents: 0,
        successPath: "/settings/billing?paid=1&card=1",
      });
    });

    it("a mismatch whose expire is rejected but the re-read says EXPIRED: released, then ONE new session", async () => {
      const h = make({ ...held, session: live(OLD_CARD_ADD), expired: rejected() });
      h.stripe.getCheckoutSession
        .mockReset()
        .mockResolvedValueOnce(live(OLD_CARD_ADD))
        .mockResolvedValueOnce(expiredReply);
      const out = await h.svc.pay("t1", NOW);
      expect(out.checkoutUrl).toBe("https://checkout.stripe.test/new");
      expect(h.stripe.getCheckoutSession).toHaveBeenCalledTimes(2);
      expect(h.claim.onSessionExpired).toHaveBeenCalledWith(expiredReply);
      expect(h.catchup.open).toHaveBeenCalledTimes(1);
    });
  });

  describe("row 3: matching terms are reused exactly as today (no expire, no release, no create)", () => {
    it.each([
      ["a stub bill", report(), TERMS_META],
      ["a card add", trialReport(), TRIAL_TERMS_META],
    ])("%s", async (_n, rep, meta) => {
      const h = make({
        sub: held.sub,
        report: { ...rep, eligible: false, ineligible: ["claim_held"] } as any,
        session: live({ ...T, ...meta }),
      });
      expect(await h.svc.pay("t1", NOW)).toEqual({
        checkoutUrl: "https://checkout.stripe.test/old",
      });
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
      expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
      expect(h.catchup.open).not.toHaveBeenCalled();
    });

    it("a forgiven stub: the session carries 0, the planner's charge-now is 0 (not its forgiven total)", async () => {
      const h = make({
        sub: held.sub,
        report: report(
          { eligible: false, ineligible: ["claim_held"] },
          { totalCents: 30, belowStripeMinimum: true },
        ),
        session: live({
          ...T,
          ...termsMeta(report({}, { totalCents: 30, belowStripeMinimum: true })),
          catchup_forgiven_cents: "30",
        }),
      });
      expect(await h.svc.pay("t1", NOW)).toEqual({
        checkoutUrl: "https://checkout.stripe.test/old",
      });
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
    });
  });

  describe("row 4: the old session completed first -> AWAITING_FIRST_PAYMENT, ZERO new sessions, claim untouched", () => {
    const pending = { response: { code: API_ERROR_CODES.CATCHUP_PENDING } };

    it("expire rejected, re-read says COMPLETE", async () => {
      const h = make({ ...held, session: live(OLD_CARD_ADD), expired: rejected() });
      h.stripe.getCheckoutSession
        .mockReset()
        .mockResolvedValueOnce(live(OLD_CARD_ADD))
        .mockResolvedValueOnce(completeReply);
      await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject(pending);
      expect(h.stripe.expireCheckoutSession).toHaveBeenCalledTimes(1);
      expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
      expect(h.catchup.open).not.toHaveBeenCalled();
    });

    it("the expire reply itself says COMPLETE", async () => {
      const h = make({ ...held, session: live(OLD_CARD_ADD), expired: completeReply });
      await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject(pending);
      expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
      expect(h.catchup.open).not.toHaveBeenCalled();
    });
  });

  describe("row 5: a mismatch whose expire cannot be confirmed is a 503, nothing released, nothing created", () => {
    it("expire network error and the re-read still open", async () => {
      await expect503(
        make({ ...held, session: live(OLD_CARD_ADD), expired: new Error("ECONNRESET") }),
      );
    });

    it("expire rejected and the re-read is null", async () => {
      const h = make({ ...held, session: live(OLD_CARD_ADD), expired: rejected() });
      h.stripe.getCheckoutSession
        .mockReset()
        .mockResolvedValueOnce(live(OLD_CARD_ADD))
        .mockResolvedValueOnce(null);
      await expect503(h);
    });

    it("expire rejected and the re-read fails", async () => {
      const h = make({ ...held, session: live(OLD_CARD_ADD), expired: rejected() });
      h.stripe.getCheckoutSession
        .mockReset()
        .mockResolvedValueOnce(live(OLD_CARD_ADD))
        .mockRejectedValueOnce(new Error("ETIMEDOUT"));
      await expect503(h);
    });

    it("an unusable (null) expire reply", async () => {
      await expect503(make({ ...held, session: live(OLD_CARD_ADD), expired: null }));
    });
  });

  describe("row 6: metadata missing or unreadable is unknown -> 503, Stripe not even told to expire", () => {
    it.each([
      ["no metadata", undefined],
      ["metadata without the terms keys", T],
      [
        "a stub-cents value that is not an integer",
        { ...T, ...TERMS_META, catchup_stub_cents: "x" },
      ],
      ["a catchup_to that is not a date", { ...T, ...TERMS_META, catchup_to: "soon" }],
      ["no catchup_shape", { ...T, ...TERMS_META, catchup_shape: undefined }],
      [
        "no terms signature (created before it existed)",
        { ...T, ...TERMS_META, catchup_terms_sig: undefined },
      ],
      ["a malformed terms signature", { ...T, ...TERMS_META, catchup_terms_sig: "abc" }],
    ])("%s", async (_n, meta) => {
      const h = make({ ...held, session: live(meta as any) });
      await expect503(h);
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
    });
  });

  it("a dead session (past its time) never needs its metadata: the old path is unchanged", async () => {
    const stale = { ...live(undefined), expires_at: Math.floor(NOW.getTime() / 1000) - 60 };
    const h = make({ ...held, session: stale, expired: expiredReply });
    expect((await h.svc.pay("t1", NOW)).checkoutUrl).toBe("https://checkout.stripe.test/new");
    expect(h.stripe.expireCheckoutSession).toHaveBeenCalledTimes(1);
    expect(h.catchup.open).toHaveBeenCalledTimes(1);
  });

  it("a raced session with the same terms is handed back; with other terms it is expired and the click retries (503), never a second session", async () => {
    const racedUrl = "https://checkout.stripe.test/raced";
    const lost = () =>
      new ConflictException({ code: API_ERROR_CODES.CATCHUP_SESSION_OPEN, message: "x" });
    const mk = (meta: Record<string, string>, expired?: unknown) => {
      const h = make({
        session: { ...live({ ...T, ...meta }), url: racedUrl },
        expired: expired as any,
      });
      h.prisma.tenantSubscription.findUnique
        .mockResolvedValueOnce({ catchupState: null, catchupSessionId: null })
        .mockResolvedValue({ catchupState: "SESSION_OPEN", catchupSessionId: "cs_old" });
      h.catchup.open.mockRejectedValueOnce(lost());
      return h;
    };
    const same = mk(TERMS_META);
    expect(await same.svc.pay("t1", NOW)).toEqual({ checkoutUrl: racedUrl });
    expect(same.catchup.open).toHaveBeenCalledTimes(1);

    const other = mk({ ...TERMS_META, catchup_stub_cents: "40000" }, expiredReply);
    await expect(other.svc.pay("t1", NOW)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN },
    });
    expect(other.stripe.expireCheckoutSession).toHaveBeenCalledTimes(1);
    expect(other.catchup.open).toHaveBeenCalledTimes(1); // the failed create only: no second session
  });
  describe("nit 2: the lost-race path never expires a FRESHER winner", () => {
    const racedUrl = "https://checkout.stripe.test/raced";
    const lost = () =>
      new ConflictException({ code: API_ERROR_CODES.CATCHUP_SESSION_OPEN, message: "x" });
    const heldTrial = (over: Record<string, unknown> = {}) =>
      trialReport({ eligible: false, ineligible: ["claim_held"], ...over });
    const heldBill = () => report({ eligible: false, ineligible: ["claim_held"] });
    /** Click A planned `first`; the winner's session was built for `sessionMeta`; the re-plan reads `second`. */
    function race(first: any, sessionMeta: Record<string, string>, second: any, expired?: unknown) {
      const h = make({
        report: first,
        session: { ...live({ ...T, ...sessionMeta }), url: racedUrl },
        expired: expired as any,
      });
      h.catchup.plan.mockReset().mockResolvedValueOnce(first).mockResolvedValue(second);
      h.prisma.tenantSubscription.findUnique
        .mockResolvedValueOnce({ catchupState: null, catchupSessionId: null })
        .mockResolvedValue({ catchupState: "SESSION_OPEN", catchupSessionId: "cs_old" });
      h.catchup.open.mockRejectedValueOnce(lost());
      return h;
    }

    it("click A planned the card add (pre-D); the winner's session is the post-D bill: A re-plans, it matches, A returns the winner's url, no expire", async () => {
      const h = race(heldTrial(), termsMeta(report()), heldBill());
      expect(await h.svc.pay("t1", NOW)).toEqual({ checkoutUrl: racedUrl });
      expect(h.catchup.plan).toHaveBeenCalledTimes(2); // the request's read and ONE re-plan
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
      expect(h.claim.onSessionExpired).not.toHaveBeenCalled();
      expect(h.catchup.open).toHaveBeenCalledTimes(1);
    });

    it("the re-plan still disagrees with the winner's session: it is expired (the old rule), A retries with a 503", async () => {
      const h = race(
        heldTrial(),
        { ...termsMeta(report()), catchup_stub_cents: "40000" },
        heldBill(),
        expiredReply,
      );
      await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN },
      });
      expect(h.catchup.plan).toHaveBeenCalledTimes(2);
      expect(h.stripe.expireCheckoutSession).toHaveBeenCalledTimes(1);
      expect(h.claim.onSessionExpired).toHaveBeenCalledTimes(1);
      expect(h.catchup.open).toHaveBeenCalledTimes(1); // the lost create only: never a second session
    });

    it("a matching winner is returned without a re-plan", async () => {
      const h = race(heldBill(), termsMeta(report()), heldBill());
      expect(await h.svc.pay("t1", NOW)).toEqual({ checkoutUrl: racedUrl });
      expect(h.catchup.plan).toHaveBeenCalledTimes(1);
    });

    it("the re-plan is for the fresh clock, not this request's", async () => {
      const h = race(heldTrial(), termsMeta(report()), heldBill());
      await h.svc.pay("t1", NOW);
      expect(h.catchup.plan.mock.calls[0][1]).toBe(NOW);
      expect(h.catchup.plan.mock.calls[1][1]).not.toBe(NOW);
      expect(h.catchup.plan.mock.calls[1][1].getTime()).toBeGreaterThan(NOW.getTime());
    });

    it("an unreadable winner (no signature) is still a 503: no re-plan, no expire", async () => {
      const h = race(heldTrial(), { ...termsMeta(report()), catchup_terms_sig: "" }, heldBill());
      await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject({
        response: { code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN },
      });
      expect(h.catchup.plan).toHaveBeenCalledTimes(1);
      expect(h.stripe.expireCheckoutSession).not.toHaveBeenCalled();
    });
  });
});

describe("nit 3: the 503 logs WHY (the body is the same PAYMENT_STATE_UNKNOWN)", () => {
  const T = { tenantId: "t1", catchup: "period" };
  const held = {
    sub: { catchupState: "SESSION_OPEN", catchupSessionId: "cs_old" },
    report: report({ eligible: false, ineligible: ["claim_held"] }),
  };
  const live = (metadata: Record<string, unknown> | undefined) => ({
    id: "cs_old",
    status: "open",
    url: "https://checkout.stripe.test/old",
    expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
    ...(metadata === undefined ? {} : { metadata }),
  });
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const logged = () => warn.mock.calls.map((c) => String(c[0])).join("\n");

  async function expectCode503(h: ReturnType<typeof make>) {
    await expect(h.svc.pay("t1", NOW)).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN },
    });
  }

  it("unreadable terms: reason=terms_unreadable", async () => {
    await expectCode503(make({ ...held, session: live({ ...T }) }));
    expect(logged()).toContain("reason=terms_unreadable");
    expect(logged()).not.toContain("reason=stripe_unreachable");
  });

  it("Stripe unreachable on the read: reason=stripe_unreachable", async () => {
    await expectCode503(make({ ...held, readError: new Error("ETIMEDOUT") }));
    expect(logged()).toContain("reason=stripe_unreachable");
    expect(logged()).not.toContain("reason=terms_unreadable");
  });

  it("Stripe unreachable on the re-read after a rejected expire: reason=stripe_unreachable", async () => {
    const stale = { ...live({ ...T }), expires_at: 1 };
    const h = make({ ...held, session: stale, expired: new Error("not open") });
    h.stripe.getCheckoutSession
      .mockReset()
      .mockResolvedValueOnce(stale)
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    await expectCode503(h);
    expect(logged()).toContain("reason=stripe_unreachable");
  });

  it("an unexpected session status: reason=unexpected_status", async () => {
    await expectCode503(make({ ...held, session: { id: "cs_old", status: "weird" } }));
    expect(logged()).toContain("reason=unexpected_status");
  });

  it("an unusable expire reply: reason=unexpected_status", async () => {
    const stale = { ...live({ ...T }), expires_at: 1 };
    await expectCode503(make({ ...held, session: stale, expired: null }));
    expect(logged()).toContain("reason=unexpected_status");
  });
});
