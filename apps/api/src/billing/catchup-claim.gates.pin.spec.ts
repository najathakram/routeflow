jest.mock("./coupon-state", () => ({
  applyCouponStateTx: jest.fn(async () => ({ applied: true, stale: false, amountDelta: 0 })),
}));
import { dunningEligible } from "./dunning-core";
import { DISCOVERY_WHERE, SETTLE_WHERE } from "./dunning-discovery";
import { stampClock } from "./dunning-stamp";
import { SubscriptionBillingExtras } from "./subscription-billing-extras";
import { fakeCatchupDb } from "../testing/fake-catchup-db";

/**
 * SA-733r9 rule 9 - PIN (green on master 5a938f0a2, kept as a guard): the gates ignore a catch-up IN FLIGHT. After a
 * catch-up session completes the tenant has `externalPayment = false` (manual invoicing is off) but still holds the
 * claim (`catchupState` set) until the first money settles it. In that window:
 *   - the r7 dunning stamp / sweep / discovery skip it (r3 N2(a)), and
 *   - the B4 grace banner shows nothing, because no `pastDueInvoiceId` / `pastDueSince` is ever stamped.
 */
const HELD_STATES = ["SESSION_OPEN", "AWAITING_FIRST_PAYMENT", "RELEASING"];

describe("PIN: a tenant with a held catch-up claim and externalPayment false", () => {
  it.each(HELD_STATES)("dunning does not touch it (claim %s)", (state) => {
    expect(
      dunningEligible({ stripeSubId: "sub_1", externalPayment: false, catchupState: state }),
    ).toBe(false);
    // the same row WITHOUT a claim is the ordinary Stripe-billed tenant dunning is for
    expect(
      dunningEligible({ stripeSubId: "sub_1", externalPayment: false, catchupState: null }),
    ).toBe(true);
  });

  it("the discovery and sweep populations both require catchupState = null", () => {
    expect(DISCOVERY_WHERE).toMatchObject({ externalPayment: false, catchupState: null });
    expect(SETTLE_WHERE).toMatchObject({ externalPayment: false, catchupState: null });
  });

  it.each(HELD_STATES)(
    "the ONE clock writer (stampClock) refuses to stamp it (claim %s), so no pastDueInvoiceId appears",
    async (state) => {
      const db = fakeCatchupDb({
        subs: [
          {
            tenantId: "t1",
            stripeSubId: "sub_1",
            externalPayment: false,
            catchupState: state,
            pastDueInvoiceId: null,
            pastDueSince: null,
          },
        ],
      });
      const wrote = await stampClock(
        { prisma: db.prisma } as any,
        "t1",
        "in_1",
        new Date("2026-11-08T10:00:00Z"),
      );
      expect(wrote).toBe(false);
      expect(db.subs[0].pastDueInvoiceId).toBeNull();
      expect(db.subs[0].pastDueSince).toBeNull();
      // and an ordinary row (no claim) IS stamped by the same call - the skip is the claim, nothing else
      const ordinary = fakeCatchupDb({
        subs: [
          {
            tenantId: "t2",
            stripeSubId: "sub_2",
            externalPayment: false,
            catchupState: null,
            pastDueInvoiceId: null,
            pastDueSince: null,
          },
        ],
      });
      expect(
        await stampClock(
          { prisma: ordinary.prisma } as any,
          "t2",
          "in_2",
          new Date("2026-11-08T10:00:00Z"),
        ),
      ).toBe(true);
    },
  );

  it("the grace banner has nothing to show: an unstamped row reads no past-due month and no grace-ends date", async () => {
    const prisma = {
      getTenantId: () => null,
      tenantConfig: { findUnique: jest.fn().mockResolvedValue({ timezone: null }) },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
    } as any;
    const stripe = {
      isConfigured: false,
      getInvoiceFacts: jest.fn(),
      getDefaultCardSummary: jest.fn(),
      previewNextInvoice: jest.fn(),
    } as any;
    const extras = new SubscriptionBillingExtras(prisma, stripe);
    const out = await extras.read("t1", {
      pastDueSince: null,
      pastDueInvoiceId: null,
      stripeCustomerId: "cus_1",
      stripeSubId: "sub_1",
      cancelAtPeriodEnd: false,
      failedPaymentCount: 0,
      periodEnd: new Date("2026-12-01T12:00:00Z"),
    } as any);
    expect(out.pastDueMonthLabel).toBeNull();
    expect(out.graceEndsLabel).toBeNull();
    expect(stripe.getInvoiceFacts).not.toHaveBeenCalled();
  });
});
