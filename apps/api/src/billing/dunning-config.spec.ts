import {
  ADMIN_SET_REASON,
  billingPauseMode,
  DUNNING_D3_HOURS,
  DUNNING_D7_HOURS,
  DUNNING_LAST_DAY_HOURS,
  DUNNING_FINAL_LEAD_HOURS,
  DUNNING_MILESTONES,
  dunningEmailsFor,
  DUNNING_PAUSE_HOURS,
  PAUSE_LOCAL_HOUR,
  OVERDUE_SUSPENDED_REASON,
  paymentReinstatable,
  paymentReinstatableWhere,
  STRIPE_CANCELLED_REASON,
} from "./dunning-config";

describe("dunning-config (SA-733r7 PR-B3)", () => {
  // SA-1037 r2 (the owner's "pause at 14 days", 05:21Z) SUPERSEDES the day-7 pause these pins held (168 / 144).
  it("names the thresholds: +72 h / +168 h reminders, the last day at +312 h, the pause at +336 h, a 24 h final-notice lead, 03:00 local", () => {
    expect(DUNNING_D3_HOURS).toBe(72);
    expect(DUNNING_D7_HOURS).toBe(168);
    expect(DUNNING_LAST_DAY_HOURS).toBe(312);
    expect(DUNNING_PAUSE_HOURS).toBe(336);
    expect(DUNNING_FINAL_LEAD_HOURS).toBe(24);
    expect(PAUSE_LOCAL_HOUR).toBe(3);
  });

  it("keys the reminders d0 / d3 / d7 / d6 (the last day) plus the final, paused and paused-still-owed notices", () => {
    expect(DUNNING_MILESTONES).toEqual({
      D0: "DUNNING_D0",
      D3: "DUNNING_D3",
      D7: "DUNNING_D7",
      D6: "DUNNING_D6",
      FINAL: "DUNNING_FINAL",
      PAUSED: "DUNNING_PAUSED",
      PAUSED_STILL_OWED: "DUNNING_PAUSED_STILL_OWED",
    });
  });

  it("dunningEmailsFor (SA r-note 5 A1): off and dark send master's failed-payment email only; enforced sends the milestone series only", () => {
    expect(dunningEmailsFor("off")).toBe("legacy_failed_payment");
    expect(dunningEmailsFor("dark")).toBe("legacy_failed_payment");
    expect(dunningEmailsFor("enforced")).toBe("milestones");
  });

  it("BILLING_PAUSE_MODE defaults to dark; only an exact off / enforced changes it", () => {
    expect(billingPauseMode({})).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "" })).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "dark" })).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "off" })).toBe("off");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: " Enforced " })).toBe("enforced");
  });

  it("a typo can never turn the pause on", () => {
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "enforce" })).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "true" })).toBe("dark");
    expect(billingPauseMode({ BILLING_PAUSE_MODE: "on" })).toBe("dark");
  });
});

// SA-832 row 453: ONE predicate decides whether a payment may lift a lock, shared by the checkout completion, the
// invoice.payment_succeeded reinstatement, subscribe() and checkout creation. Only a BILLING-caused lock lifts.
describe("paymentReinstatable (SA-832 / row 453)", () => {
  it.each([
    ["ACTIVE (nothing to lift)", "ACTIVE", null],
    ["TRIAL", "TRIAL", null],
    ["TRIAL with a stale admin_set reason", "TRIAL", "admin_set"],
    ["READ_ONLY(trial_expired)", "READ_ONLY", "trial_expired"],
    ["READ_ONLY(trial_cancelled)", "READ_ONLY", "trial_cancelled"],
    ["READ_ONLY(payment_overdue)", "READ_ONLY", "payment_overdue"],
    ["READ_ONLY(subscription_cancelled)", "READ_ONLY", "subscription_cancelled"],
    ["SUSPENDED by billing (no reason)", "SUSPENDED", null],
    ["SUSPENDED with a billing reason", "SUSPENDED", "overdue_payment"],
    ["SUSPENDED by the overdue cron (W-664 stamp)", "SUSPENDED", "overdue_suspended"],
    // SA-832b: a Stripe churn is NOT an admin lock - the back-office win-back link must still work for it
    ["CANCELLED by a Stripe churn (stripe_cancelled)", "CANCELLED", "stripe_cancelled"],
  ])("%s: a payment lifts it", (_n, status, reason) => {
    expect(paymentReinstatable(status, reason)).toBe(true);
  });

  it.each([
    ["READ_ONLY(admin_set)", "READ_ONLY", "admin_set"],
    ["READ_ONLY with no reason (a legacy admin write)", "READ_ONLY", null],
    ["READ_ONLY with an unknown reason", "READ_ONLY", "something_new"],
    ["SUSPENDED(admin_set): an admin's suspension", "SUSPENDED", "admin_set"],
    // SA-832b: legacy CANCELLED rows carry no reason; they stay REFUSED (safe) until a backfill classifies them
    ["CANCELLED with no reason (a legacy row: admin or churn, unknowable)", "CANCELLED", null],
    ["CANCELLED by an admin (admin_set)", "CANCELLED", "admin_set"],
    ["CANCELLED with a stale reason", "CANCELLED", "trial_expired"],
    ["an unknown status", "ARCHIVED", null],
    ["a missing status", undefined, null],
    ["a null status", null, null],
  ])("%s: a payment NEVER lifts it", (_n, status, reason) => {
    expect(paymentReinstatable(status as string | null | undefined, reason)).toBe(false);
  });

  it("stamps the admin lock with the constant the predicate reads", () => {
    expect(ADMIN_SET_REASON).toBe("admin_set");
    expect(STRIPE_CANCELLED_REASON).toBe("stripe_cancelled");
    expect(OVERDUE_SUSPENDED_REASON).toBe("overdue_suspended");
  });
});

describe("paymentReinstatableWhere (SA-832 / row 453): the same predicate as a CAS filter", () => {
  /** A tiny evaluator for exactly the Prisma shapes the filter may use (equality, `in`, `startsWith`, `not`, null, OR). */
  const matches = (where: any, row: { status: string; readOnlyReason: string | null }): boolean => {
    return Object.entries(where).every(([k, cond]: [string, any]) => {
      if (k === "OR") return cond.some((w: any) => matches(w, row));
      if (k === "AND") return cond.every((w: any) => matches(w, row));
      const v = (row as any)[k];
      if (cond === null) return v === null;
      if (typeof cond === "string") return v === cond;
      if (cond.in) return cond.in.includes(v);
      if (cond.startsWith) return typeof v === "string" && v.startsWith(cond.startsWith);
      if ("not" in cond) return v !== null && v !== cond.not; // SQL: NULL <> 'x' is not true
      throw new Error(`unmodelled filter shape for ${k}`);
    });
  };
  const statuses = ["ACTIVE", "TRIAL", "READ_ONLY", "SUSPENDED", "CANCELLED"];
  const reasons = [
    null,
    "admin_set",
    "trial_expired",
    "trial_cancelled",
    "payment_overdue",
    "subscription_cancelled",
    "overdue_payment",
    "stripe_cancelled",
    "zzz",
  ];

  it("selects exactly the non-ACTIVE rows the function allows (every status x reason cell)", () => {
    for (const status of statuses) {
      for (const readOnlyReason of reasons) {
        const expected = status !== "ACTIVE" && paymentReinstatable(status, readOnlyReason);
        const actual = matches(
          { AND: [{ status: { not: "ACTIVE" } }, paymentReinstatableWhere()] },
          { status, readOnlyReason },
        );
        expect({ status, readOnlyReason, actual }).toEqual({
          status,
          readOnlyReason,
          actual: expected,
        });
      }
    }
  });
});
