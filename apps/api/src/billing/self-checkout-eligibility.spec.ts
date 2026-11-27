import {
  SELF_PAY_DURING_TRIAL,
  selfCheckoutEligibility,
  selfPayForViewer,
  type SelfCheckoutFacts,
} from "./self-checkout-eligibility";

/**
 * SA-1547 PR-3 (ruling 2026-11-26, section 2): who sees "Pay now". One pure helper, a coded reason, never a bare
 * boolean. Live: LITE not ACTIVE, and a trial-expired READ_ONLY. Everything else is listed here with its own reason.
 */

const BASE: SelfCheckoutFacts = {
  status: "READ_ONLY",
  readOnlyReason: "trial_expired",
  class: "PRODUCTION",
  deletedAt: null,
  planKey: "STARTER",
  stripeSubId: null,
  externalPayment: false,
  couponCoversAll: false,
  linkPending: false,
  monthly: 99,
};
const facts = (over: Partial<SelfCheckoutFacts> = {}): SelfCheckoutFacts => ({ ...BASE, ...over });

describe("selfCheckoutEligibility (live branches)", () => {
  it("R2: a trial-expired READ_ONLY business is eligible, reason trial_expired", () => {
    expect(selfCheckoutEligibility(facts())).toEqual({ eligible: true, reason: "trial_expired" });
  });

  it("R2: a trial_cancelled READ_ONLY business is eligible too", () => {
    expect(selfCheckoutEligibility(facts({ readOnlyReason: "trial_cancelled" }))).toEqual({
      eligible: true,
      reason: "trial_expired",
    });
  });

  it("an invited LITE business that is not ACTIVE is eligible (today's behaviour), reason lite_payment_due", () => {
    expect(
      selfCheckoutEligibility(facts({ planKey: "LITE", status: "TRIAL", readOnlyReason: null })),
    ).toEqual({ eligible: true, reason: "lite_payment_due" });
  });
});

describe("selfCheckoutEligibility (REG-6: the invite-only lever)", () => {
  it("an invited LITE business is not eligible while the self-serve-checkout lever is off", () => {
    jest.isolateModules(() => {
      jest.doMock("./plan-catalog.constants", () => ({
        ...jest.requireActual("./plan-catalog.constants"),
        INVITE_ONLY_PLAN_SELF_SERVE_CHECKOUT: false,
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod =
        require("./self-checkout-eligibility") as typeof import("./self-checkout-eligibility");
      expect(
        mod.selfCheckoutEligibility(
          facts({ planKey: "LITE", status: "TRIAL", readOnlyReason: null }),
        ),
      ).toEqual({ eligible: false, reason: "not_self_pay_state" });
    });
    jest.dontMock("./plan-catalog.constants");
  });
});

describe("selfCheckoutEligibility (not live)", () => {
  it("B1: the trial constant is false (owner-final 2026-11-24)", () => {
    expect(SELF_PAY_DURING_TRIAL).toBe(false);
  });

  it("R1: a TRIAL business with days left is not eligible, reason trial_active", () => {
    expect(selfCheckoutEligibility(facts({ status: "TRIAL", readOnlyReason: null }))).toEqual({
      eligible: false,
      reason: "trial_active",
    });
  });

  it("ACTIVE with no card subscription is excluded until owner box Q4", () => {
    expect(selfCheckoutEligibility(facts({ status: "ACTIVE", readOnlyReason: null }))).toEqual({
      eligible: false,
      reason: "active_no_card",
    });
  });

  it("a dunning READ_ONLY keeps the Pay invoice strip, not Pay now", () => {
    expect(
      selfCheckoutEligibility(facts({ readOnlyReason: "payment_overdue", stripeSubId: null })),
    ).toEqual({ eligible: false, reason: "not_self_pay_state" });
  });

  it("externalPayment keeps the catch-up banner", () => {
    expect(selfCheckoutEligibility(facts({ externalPayment: true }))).toEqual({
      eligible: false,
      reason: "external_payment",
    });
  });

  it("a business with a Stripe subscription id is not eligible", () => {
    expect(selfCheckoutEligibility(facts({ stripeSubId: "sub_1" }))).toEqual({
      eligible: false,
      reason: "live_subscription",
    });
  });

  it("a payment already settling (link pending) is not eligible", () => {
    expect(selfCheckoutEligibility(facts({ linkPending: true }))).toEqual({
      eligible: false,
      reason: "link_pending",
    });
  });

  it("an admin-set READ_ONLY (a payment may not reinstate it) is not eligible", () => {
    expect(selfCheckoutEligibility(facts({ readOnlyReason: "admin_set" }))).toEqual({
      eligible: false,
      reason: "not_reinstatable",
    });
  });

  it("a full coupon is not eligible (the row is unbilled)", () => {
    expect(selfCheckoutEligibility(facts({ couponCoversAll: true }))).toEqual({
      eligible: false,
      reason: "coupon_full",
    });
  });

  // Ruling 7203127751 item 1: the class check is the live-payments wall's own predicate (live-payments-wall.ts),
  // so Pay now is never offered where the wall would refuse the session, and a test key opens every class.
  it.each(["TEST", "DEMO", "INTERNAL", null, "SOMETHING_NEW"])(
    "class %p with a live key: not eligible (live_payments_off), the wall's verdict",
    (cls) => {
      expect(selfCheckoutEligibility(facts({ class: cls as any, keyMode: "live" }))).toEqual({
        eligible: false,
        reason: "live_payments_off",
      });
    },
  );

  it("class TEST with a Stripe TEST key is eligible (the walks run on any class, SA-1547 S5)", () => {
    expect(selfCheckoutEligibility(facts({ class: "TEST", keyMode: "test" })).eligible).toBe(true);
  });

  it("a key that is neither live nor test (none) fails closed for a non-PRODUCTION class", () => {
    expect(selfCheckoutEligibility(facts({ class: "TEST", keyMode: "none" })).reason).toBe(
      "live_payments_off",
    );
  });

  it("a deleted business, or one with no plan, is not a paying row", () => {
    expect(selfCheckoutEligibility(facts({ deletedAt: new Date() })).reason).toBe("not_paying_row");
    expect(selfCheckoutEligibility(facts({ planKey: null })).reason).toBe("not_paying_row");
  });

  it.each([null, 0, -5])("a server price of %s is not eligible (no_price)", (monthly) => {
    expect(selfCheckoutEligibility(facts({ monthly }))).toEqual({
      eligible: false,
      reason: "no_price",
    });
  });
});

describe("selfPayForViewer (who may see Pay now)", () => {
  const view = {
    eligible: true,
    reason: "trial_expired" as const,
    planKey: "STARTER",
    planName: "Starter",
    monthly: 99,
    addons: [],
    firstFullChargeAt: "2026-12-01T12:00:00.000Z",
  };

  it("R5: an OPERATOR is never offered Pay now", () => {
    expect(selfPayForViewer(view, { role: "OPERATOR", impersonated: false })).toMatchObject({
      eligible: false,
      reason: "not_admin",
    });
  });

  it("R5: an impersonating super admin is never offered Pay now", () => {
    expect(selfPayForViewer(view, { role: "TENANT_ADMIN", impersonated: true })).toMatchObject({
      eligible: false,
      reason: "support_session",
    });
  });

  it("a TENANT_ADMIN keeps the view untouched", () => {
    expect(selfPayForViewer(view, { role: "TENANT_ADMIN", impersonated: false })).toEqual(view);
  });
});
