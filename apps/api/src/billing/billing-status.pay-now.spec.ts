import { billingStatusOf, type BillingStatusInput } from "./billing-status";

/**
 * SA-1547 PR-3 (ruling section 2, entry points): the trial-ended state's primary action is PAY_NOW when the server
 * says the business may pay itself (`selfPay.eligible`), and stays CHOOSE_PLAN otherwise. Staff never get either.
 */
const NOW = new Date("2026-11-15T12:00:00.000Z");
const NO_DUE = {
  due: false,
  pastDue: false,
  amountCents: 0,
  periodLabel: null,
  periodStart: null,
  cardNeeded: false,
  chargeStartsOn: null,
  cardBy: null,
};
const PAY_NOW = { kind: "pay_now", target: "self_checkout" } as const;
const CHOOSE_PLAN = { kind: "choose_plan", target: "choose_plan" } as const;

function input(sub: Record<string, unknown>, isAdmin = true): BillingStatusInput {
  return {
    subscription: {
      status: "READ_ONLY",
      trialEndsAt: "2026-11-10T12:00:00.000Z",
      readOnlyReason: "trial_expired",
      pastDueInvoiceId: null,
      pastDueSince: null,
      paymentMethodSummary: null,
      nextCharge: null,
      ...sub,
    } as BillingStatusInput["subscription"],
    paymentDue: NO_DUE,
    now: NOW,
    timeZone: "America/Chicago",
    isAdmin,
  };
}
const selfPay = (eligible: boolean) => ({ eligible, reason: eligible ? "trial_expired" : "x" });

describe("billingStatusOf: PAY_NOW on trial_ended (R2)", () => {
  it("R2: a trial-expired lock with selfPay.eligible gets Pay now, not Choose a plan", () => {
    expect(billingStatusOf(input({ selfPay: selfPay(true) })).action).toEqual(PAY_NOW);
  });

  it("a TRIAL status past its end date with selfPay.eligible gets Pay now too", () => {
    const v = billingStatusOf(
      input({ status: "TRIAL", readOnlyReason: null, selfPay: selfPay(true) }),
    );
    expect(v).toMatchObject({ state: "trial_ended", action: PAY_NOW });
  });

  it("not eligible (or no selfPay at all): Choose a plan, as before", () => {
    expect(billingStatusOf(input({ selfPay: selfPay(false) })).action).toEqual(CHOOSE_PLAN);
    expect(billingStatusOf(input({})).action).toEqual(CHOOSE_PLAN);
  });

  it("staff never get an action", () => {
    expect(billingStatusOf(input({ selfPay: selfPay(true) }, false)).action).toBeNull();
  });

  it("the trial notice (days left) never offers Pay now (B1): it stays Choose a plan", () => {
    const v = billingStatusOf(
      input({
        status: "TRIAL",
        readOnlyReason: null,
        trialEndsAt: "2026-11-18T12:00:00.000Z",
        selfPay: selfPay(true),
      }),
    );
    expect(v).toMatchObject({ state: "trial", action: CHOOSE_PLAN });
  });
});
