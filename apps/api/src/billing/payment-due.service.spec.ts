import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
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
      },
    });
    const out = await svc.pay("t1", NOW);
    expect(out).toEqual({ checkoutUrl: "https://checkout.stripe.test/open" });
    expect(stripe.getCheckoutSession).toHaveBeenCalledWith("cs_open");
    expect(catchup.open).not.toHaveBeenCalled();
  });

  describe("F2: the stored session is read, and Stripe is told before anything is released", () => {
    const PAST = Math.floor(NOW.getTime() / 1000) - 60;
    const META = { tenantId: "t1", catchup: "1" };
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

    it("a network error on expire() is a retryable 503 PAYMENT_STATE_UNKNOWN: nothing released, nothing created", async () => {
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
