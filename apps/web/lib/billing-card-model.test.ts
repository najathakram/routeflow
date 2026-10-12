import type { SubscriptionView } from "@routeflow/types";
import { billingCardModel } from "./billing-card-model";

/** SA-777 / billing-ux.md: each of the five states, admin and operator, with the EXACT copy. */
const NOW = new Date("2026-10-15T12:00:00Z");
function view(over: Partial<SubscriptionView> = {}): SubscriptionView {
  return {
    planKey: "GROWTH",
    planName: "Growth",
    status: "ACTIVE",
    cycle: "MONTHLY",
    monthlyPrice: 149,
    annualPrice: 1490,
    isCustom: false,
    renewalAt: "2026-11-01T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    downgradeToPlanKey: null,
    downgradeEffectiveAt: null,
    trialEndsAt: null,
    addons: [],
    paymentRequired: false,
    readOnlyReason: null,
    billingContactName: "Dana",
    billingContactEmail: "dana@example.test",
    paymentMethodSummary: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2027 },
    nextCharge: { amount: 149, date: "2026-11-01T12:00:00.000Z", dateLabel: "Nov 1" },
    ...over,
  };
}

describe("billingCardModel (SA-777)", () => {
  it("Current: pill, '$X / month', autopay sub line, only the portal button", () => {
    const m = billingCardModel(
      view({ billingState: "current", outstandingTotal: 0 }),
      "admin",
      NOW,
    )!;
    expect(m.pill).toEqual({ label: "Current", tone: "success" });
    expect(m.amountLine).toBe("$149.00 / month");
    expect(m.subLine).toBe("Autopay on · Visa •••• 4242 · next charge Nov 1");
    expect(m.pay).toBeNull();
    expect(m.portal).toBe(true);
  });

  it("Current with a card expiring within 30 days: amber 'Card expires 10/26'", () => {
    const m = billingCardModel(
      view({
        billingState: "current",
        paymentMethodSummary: { brand: "visa", last4: "4242", expMonth: 10, expYear: 2026 },
      }),
      "admin",
      NOW,
    )!;
    expect(m.subLine).toBe("Card expires 10/26");
    expect(m.subTone).toBe("amber");
  });

  it("Payment due: info pill, '$X due by Oct 15', Pay $X + portal", () => {
    const m = billingCardModel(
      view({
        billingState: "due",
        outstandingTotal: 149,
        openInvoiceDueLabel: "Oct 15",
        payNowUrl: "https://pay.example/in_1",
      }),
      "admin",
      NOW,
    )!;
    expect(m.pill).toEqual({ label: "Payment due", tone: "info" });
    expect(m.amountLine).toBe("$149.00 due by Oct 15");
    expect(m.subLine).toBe("Growth plan, monthly");
    expect(m.pay).toEqual({ label: "Pay $149.00", url: "https://pay.example/in_1" });
  });

  it("Overdue: amber (never red) pill, '$X overdue since Oct 1'", () => {
    const m = billingCardModel(
      view({ billingState: "overdue", outstandingTotal: 149, openInvoiceDueLabel: "Oct 1" }),
      "admin",
      NOW,
    )!;
    expect(m.pill).toEqual({ label: "Overdue", tone: "warning" });
    expect(m.amountLine).toBe("$149.00 overdue since Oct 1");
    expect(m.pay?.label).toBe("Pay $149.00");
  });

  it("Processing: neutral pill, the 3-5 business days line, NO Pay, the portal stays", () => {
    const m = billingCardModel(
      view({ billingState: "processing", paymentProcessing: true, outstandingTotal: 149 }),
      "admin",
      NOW,
    )!;
    expect(m.pill).toEqual({ label: "Processing", tone: "neutral" });
    expect(m.amountLine).toBe("$149.00 payment processing — usually 3–5 business days");
    expect(m.pay).toBeNull();
    expect(m.portal).toBe(true);
  });

  it("Read-only: warning pill; Pay only when unpaid is the reason", () => {
    const unpaid = billingCardModel(
      view({
        status: "READ_ONLY",
        readOnlyReason: "payment_overdue",
        billingState: "overdue",
        outstandingTotal: 149,
      }),
      "admin",
      NOW,
    )!;
    expect(unpaid.pill).toEqual({ label: "Read-only", tone: "warning" });
    expect(unpaid.pay?.label).toBe("Pay $149.00");
    const cancelled = billingCardModel(
      view({ status: "READ_ONLY", readOnlyReason: "subscription_cancelled" }),
      "admin",
      NOW,
    )!;
    expect(cancelled.pay).toBeNull();
    expect(cancelled.portal).toBe(true);
  });

  it("precedence: read-only beats processing beats overdue", () => {
    const base = { billingState: "overdue" as const, paymentProcessing: true };
    expect(billingCardModel(view(base), "admin", NOW)!.state).toBe("processing");
    expect(billingCardModel(view({ ...base, status: "READ_ONLY" }), "admin", NOW)!.state).toBe(
      "read-only",
    );
  });

  it("an operator: the state and date, NO buttons, who to ask", () => {
    const m = billingCardModel(
      view({
        billingState: "overdue",
        openInvoiceDueLabel: "Oct 1",
        paymentMethodSummary: null,
        nextCharge: null,
      }),
      "staff",
      NOW,
    )!;
    expect(m.amountLine).toBe("Overdue since Oct 1");
    expect(m.pay).toBeNull();
    expect(m.portal).toBe(false);
    expect(m.contact).toEqual({ name: "Dana", email: "dana@example.test" });
  });

  it("a missing field hides its line: no amount, no label, no 'undefined', no dash", () => {
    const m = billingCardModel(view({ billingState: "overdue" }), "admin", NOW)!;
    expect(m.amountLine).toBeNull();
    expect(m.pay).toEqual({ label: "Pay now" });
    expect(JSON.stringify(m)).not.toMatch(/undefined|null null|—\s*$/);
  });

  it("the server could not say: no state, no card (never 'Current')", () => {
    expect(billingCardModel(view({}), "admin", NOW)).toBeNull();
  });

  it("buyers and drivers get no billing card", () => {
    expect(billingCardModel(view({ billingState: "current" }), null, NOW)).toBeNull();
  });
});
