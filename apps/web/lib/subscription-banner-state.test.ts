import type { SubscriptionView } from "@routeflow/types";
import { readOnlyCopyForView } from "./read-only-copy";
import {
  bannerRoleOf,
  readOnlyLine,
  subscriptionBannerState,
  subscriptionPollInterval,
} from "./subscription-banner-state";

/**
 * SA-733r6 (B4) G4 pin: every banner state x role, with the EXACT signed copy (apple-ux + apple-design, G7).
 * One pure function drives the shell strip and the Billing card; there is no per-screen copy.
 */

const DAY = 86_400_000;
const T0 = new Date("2026-11-01T12:00:00Z"); // the first failed payment (day 0)
const at = (days: number, hours = 0) => new Date(T0.getTime() + days * DAY + hours * 3_600_000);

function view(over: Partial<SubscriptionView> = {}): SubscriptionView {
  return {
    planKey: "TEAM",
    planName: "Team",
    status: "ACTIVE",
    cycle: "MONTHLY",
    monthlyPrice: 149,
    annualPrice: null,
    isCustom: false,
    renewalAt: "2026-12-01T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    downgradeToPlanKey: null,
    downgradeEffectiveAt: null,
    trialEndsAt: null,
    addons: [],
    paymentRequired: false,
    readOnlyReason: null,
    billingContactEmail: "dana@acme.test",
    pastDueSince: null,
    pastDueInvoiceId: null,
    openInvoiceAmount: null,
    paymentMethodSummary: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2027 },
    nextCharge: { amount: 149, date: "2026-12-01T12:00:00.000Z" },
    ...over,
  };
}

// The server decides the labels (formatted in the TENANT zone, SA-738) and whether a pause will really happen.
const owing = (over: Partial<SubscriptionView> = {}) =>
  view({
    pastDueSince: T0.toISOString(),
    pastDueInvoiceId: "in_1",
    openInvoiceAmount: 149,
    pastDueMonthLabel: "November",
    graceEndsLabel: "Nov 8",
    pauseEnforced: true,
    ...over,
  });

const paused = (over: Partial<SubscriptionView> = {}) =>
  owing({ status: "READ_ONLY", readOnlyReason: "payment_overdue", ...over });

describe("bannerRoleOf", () => {
  it("maps staff roles and gives buyers / drivers no billing state at all", () => {
    expect(bannerRoleOf("TENANT_ADMIN")).toBe("admin");
    expect(bannerRoleOf("OPERATOR")).toBe("staff");
    expect(bannerRoleOf("CUSTOMER")).toBeNull();
    expect(bannerRoleOf("DRIVER")).toBeNull();
    expect(bannerRoleOf(undefined)).toBeNull();
  });
});

describe("subscriptionBannerState - nothing owed", () => {
  it("no view, or a healthy ACTIVE tenant with no card: nothing", () => {
    expect(subscriptionBannerState(undefined, "admin", T0).kind).toBe("none");
    expect(
      subscriptionBannerState(view({ paymentMethodSummary: null, nextCharge: null }), "admin", T0)
        .kind,
    ).toBe("none");
  });

  it("admin: autopay line lives on the Billing card, never in the shell", () => {
    const s = subscriptionBannerState(view(), "admin", T0);
    expect(s.kind).toBe("autopay");
    expect(s.cardLine).toBe("Autopay is on. Next charge: $149.00 on Dec 1.");
    expect(s.inShell).toBe(false);
    expect(s.action).toBeNull();
    expect(s.cardPay).toBeNull();
  });

  it("operator: no autopay line at all", () => {
    const s = subscriptionBannerState(view(), "staff", T0);
    expect(s.kind).toBe("none");
    expect(s.cardLine).toBeNull();
  });

  it("the next-charge date is the server's tenant-zone label, verbatim", () => {
    const s = subscriptionBannerState(
      view({ nextCharge: { amount: 149, date: "2026-12-01T03:00:00.000Z", dateLabel: "Nov 30" } }),
      "admin",
      T0,
    );
    expect(s.cardLine).toBe("Autopay is on. Next charge: $149.00 on Nov 30.");
  });

  it("without a label (an older server) the date is formatted in UTC, never the browser zone", () => {
    const s = subscriptionBannerState(
      view({ nextCharge: { amount: 149, date: "2026-12-01T03:00:00.000Z" } }),
      "admin",
      T0,
    );
    expect(s.cardLine).toBe("Autopay is on. Next charge: $149.00 on Dec 1.");
  });

  it("autopay with no next charge known still says Autopay is on, no dash", () => {
    const s = subscriptionBannerState(view({ nextCharge: null }), "admin", T0);
    expect(s.cardLine).toBe("Autopay is on.");
  });

  it("a cancel scheduled at period end is not autopay", () => {
    expect(subscriptionBannerState(view({ cancelAtPeriodEnd: true }), "admin", T0).kind).toBe(
      "none",
    );
  });

  it("a READ_ONLY tenant with no owed invoice (trial ended) is the old banner's, not ours", () => {
    const s = subscriptionBannerState(
      view({ status: "READ_ONLY", readOnlyReason: "trial_expired" }),
      "admin",
      T0,
    );
    expect(s.kind).toBe("none");
  });
});

describe("subscriptionBannerState - card expiring", () => {
  const exp = (expMonth: number, expYear: number) =>
    view({ paymentMethodSummary: { brand: "visa", last4: "4242", expMonth, expYear } });
  const OCT_20 = new Date("2026-10-20T12:00:00Z"); // 11 days before Oct 31
  const OCT_26 = new Date("2026-10-26T12:00:00Z"); // 5 days before

  it("admin, 11 days out: a card line only (the shell strip starts 7 days out)", () => {
    const s = subscriptionBannerState(exp(10, 2026), "admin", OCT_20);
    expect(s.kind).toBe("card-expiring");
    expect(s.cardLine).toBe(
      "Your Visa ending 4242 expires Oct 31. Update it to keep autopay running.",
    );
    expect(s.inShell).toBe(false);
  });

  it("admin, 5 days out: the shell strip too - neutral, Update payment, dismissible for 7 days", () => {
    const s = subscriptionBannerState(exp(10, 2026), "admin", OCT_26);
    expect(s.inShell).toBe(true);
    expect(s.tone).toBe("neutral");
    expect(s.copy).toBe("Your Visa ending 4242 expires Oct 31. Update it to keep autopay running.");
    expect(s.action).toEqual({ label: "Update payment", intent: "update-payment" });
    expect(s.dismiss).toEqual({ scope: "week", key: expect.stringContaining("4242") });
    expect(s.live).toBe("status");
  });

  it("more than 14 days out: just the autopay line", () => {
    expect(
      subscriptionBannerState(exp(10, 2026), "admin", new Date("2026-10-10T12:00:00Z")).kind,
    ).toBe("autopay");
  });

  it("operator never sees the card strip or line", () => {
    const s = subscriptionBannerState(exp(10, 2026), "staff", OCT_26);
    expect(s.kind).toBe("none");
    expect(s.inShell).toBe(false);
    expect(s.cardLine).toBeNull();
  });
});

describe("subscriptionBannerState - payment failed, days 0-5 (neutral, dismissible for the day)", () => {
  it.each([0, 1, 3, 5])("admin day %i: exact copy, Update payment, never red", (day) => {
    const s = subscriptionBannerState(owing(), "admin", at(day, 3));
    expect(s.kind).toBe("grace");
    expect(s.tone).toBe("neutral");
    expect(s.copy).toBe(
      "We couldn't charge your card for November. Update it by Nov 8 and nothing changes.",
    );
    expect(s.action).toEqual({ label: "Update payment", intent: "update-payment" });
    expect(s.dismiss).toEqual({ scope: "day", key: expect.any(String) });
    expect(s.live).toBe("status");
    expect(s.inShell).toBe(true);
  });

  it.each([0, 2, 5])("operator day %i: names the admin, no action in the DOM", (day) => {
    const s = subscriptionBannerState(owing(), "staff", at(day, 3));
    expect(s.copy).toBe(
      "There's a billing issue. Everything still works. Your admin can sort it out in Billing.",
    );
    expect(s.action).toBeNull();
    expect(s.cardPay).toBeNull();
    expect(s.dismiss).toEqual({ scope: "day", key: expect.any(String) });
  });

  it("the dismiss key changes with the day, so a dismissal lasts only that day", () => {
    const a = subscriptionBannerState(owing(), "admin", at(1, 1)).dismiss?.key;
    const b = subscriptionBannerState(owing(), "admin", at(2, 1)).dismiss?.key;
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("the admin's Billing card carries Pay $149.00 whenever an invoice is owed", () => {
    const s = subscriptionBannerState(owing(), "admin", at(2));
    expect(s.cardPay).toEqual({ label: "Pay $149.00", intent: "pay" });
  });

  it("'your admin' (lower case mid-sentence, 'Your admin' at a sentence start); never a name", () => {
    const s = subscriptionBannerState(owing(), "staff", at(1));
    expect(s.copy).toBe(
      "There's a billing issue. Everything still works. Your admin can sort it out in Billing.",
    );
    const d6 = subscriptionBannerState(owing(), "staff", at(6, 2));
    expect(d6.copy).toBe("Your workspace becomes read-only tomorrow. Let your admin know.");
  });
});

describe("subscriptionBannerState - day 6 (amber, not dismissible, announced once)", () => {
  it("admin", () => {
    const s = subscriptionBannerState(owing(), "admin", at(6, 2));
    expect(s.kind).toBe("final-day");
    expect(s.tone).toBe("amber");
    expect(s.copy).toBe(
      "Your workspace becomes read-only tomorrow. Update your payment to keep everything running.",
    );
    expect(s.action).toEqual({ label: "Update payment", intent: "update-payment" });
    expect(s.dismiss).toBeNull();
    expect(s.live).toBe("alert");
  });

  it("operator", () => {
    const s = subscriptionBannerState(owing(), "staff", at(6, 2));
    expect(s.copy).toBe("Your workspace becomes read-only tomorrow. Let your admin know.");
    expect(s.action).toBeNull();
    expect(s.dismiss).toBeNull();
    expect(s.tone).toBe("amber");
    expect(s.live).toBe("alert");
  });

  it("day 5 is still neutral and day 6 starts at +144 h", () => {
    expect(subscriptionBannerState(owing(), "admin", at(5, 23)).kind).toBe("grace");
    expect(subscriptionBannerState(owing(), "admin", at(6, 0)).kind).toBe("final-day");
  });
});

describe("subscriptionBannerState - read-only (paused): amber, not dismissible, Pay $X", () => {
  it("admin", () => {
    const s = subscriptionBannerState(paused(), "admin", at(8));
    expect(s.kind).toBe("read-only");
    expect(s.tone).toBe("amber");
    // SA-776: the owner's sentence + the mapped reason; the admin gets the action, not a contact line
    expect(s.copy).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment of $149.00 is overdue.",
    );
    expect(s.action).toEqual({ label: "Pay $149.00", intent: "pay" });
    expect(s.cardPay).toEqual({ label: "Pay $149.00", intent: "pay" });
    expect(s.dismiss).toBeNull();
    expect(s.live).toBe("alert");
    expect(s.inShell).toBe(true);
  });

  it("operator: the sentence, the reason and the contact (your admin + e-mail); no action", () => {
    const s = subscriptionBannerState(paused(), "staff", at(8));
    expect(s.copy).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment of $149.00 is overdue. To restore access, contact your admin (dana@acme.test).",
    );
    expect(s.action).toBeNull();
    expect(s.cardPay).toBeNull();
    expect(s.dismiss).toBeNull();
  });

  it("an unreadable invoice amount never prints a dash: the money is simply left out", () => {
    const s = subscriptionBannerState(paused({ openInvoiceAmount: null }), "admin", at(8));
    expect(s.copy).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment is overdue.",
    );
    expect(s.action).toEqual({ label: "Pay now", intent: "pay" });
    expect(s.copy + s.action?.label).not.toMatch(/[—–]|\s-\s/);
  });

  it("read-only while an invoice is owed stays ours even if a cancel changed the reason", () => {
    const s = subscriptionBannerState(
      paused({ readOnlyReason: "subscription_cancelled" }),
      "admin",
      at(9),
    );
    expect(s.kind).toBe("read-only");
  });

  it("the money prints with cents: $149.50", () => {
    const s = subscriptionBannerState(paused({ openInvoiceAmount: 149.5 }), "admin", at(8));
    expect(s.action?.label).toBe("Pay $149.50");
  });
});

describe("subscriptionBannerState - Don't list (binding)", () => {
  const all = (role: "admin" | "staff") => [
    subscriptionBannerState(owing(), role, at(1)),
    subscriptionBannerState(owing(), role, at(6, 2)),
    subscriptionBannerState(paused(), role, at(8)),
  ];

  it.each(["admin", "staff"] as const)("%s: no blame wording, no plan CTA, no red", (role) => {
    for (const s of all(role)) {
      const text = `${s.copy} ${s.action?.label ?? ""} ${s.cardLine ?? ""}`;
      // SA-776: the read-only state is the one place the owner's copy names the reason ("... payment ... is
      // overdue."); every grace / last-day line still never does.
      const rule =
        s.kind === "read-only"
          ? /failed|suspend|choose a plan|subscribe|countdown/i
          : /overdue|failed|suspend|choose a plan|subscribe|countdown/i;
      expect(text).not.toMatch(rule);
      expect(["neutral", "amber"]).toContain(s.tone);
    }
  });

  it("operators never get an action or a Pay line in any state", () => {
    for (const s of all("staff")) {
      expect(s.action).toBeNull();
      expect(s.cardPay).toBeNull();
    }
  });
});

describe("subscriptionBannerState - cleared", () => {
  it("after the invoice is paid the view has no pastDueInvoiceId and the strip is gone", () => {
    const s = subscriptionBannerState(
      view({ pastDueSince: null, pastDueInvoiceId: null }),
      "admin",
      at(3),
    );
    expect(s.inShell).toBe(false);
    expect(s.kind).toBe("autopay");
    expect(s.copy).toBe("");
  });
});

describe("subscriptionPollInterval", () => {
  it("polls (<= 60 s) only while a billing state is showing; stops once cleared", () => {
    expect(subscriptionPollInterval(owing())).toBeLessThanOrEqual(60_000);
    expect(subscriptionPollInterval(paused())).toBeLessThanOrEqual(60_000);
    expect(subscriptionPollInterval(view())).toBe(false);
    expect(subscriptionPollInterval(undefined)).toBe(false);
  });
});

describe("readOnlyLine", () => {
  it("is the owner's sentence + the mapped reason + (non-admin) the contact (SA-776)", () => {
    const v = paused({ openInvoiceAmount: null });
    expect(readOnlyLine(v, false)).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment is overdue. To restore access, contact your admin (dana@acme.test).",
    );
    expect(readOnlyLine(v, true)).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription payment is overdue.",
    );
    expect(readOnlyLine(null, false)).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.",
    );
    expect(readOnlyLine(undefined, true)).toBe(
      "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable.",
    );
  });
});

describe("subscriptionBannerState - labels come from the server (S4)", () => {
  it("uses the tenant-zone month and deadline verbatim (a Chicago tenant whose charge failed Oct 31 local)", () => {
    const v = owing({ pastDueMonthLabel: "October", graceEndsLabel: "Nov 7" });
    expect(subscriptionBannerState(v, "admin", at(1)).copy).toBe(
      "We couldn't charge your card for October. Update it by Nov 7 and nothing changes.",
    );
  });

  it("without labels it falls back to UTC from pastDueSince, never the browser zone", () => {
    const v = owing({ pastDueMonthLabel: null, graceEndsLabel: null });
    expect(subscriptionBannerState(v, "admin", at(1)).copy).toBe(
      "We couldn't charge your card for November. Update it by Nov 8 and nothing changes.",
    );
  });
});

// B2: BILLING_PAUSE_MODE dark / off (the default) never pauses. The grace states must not threaten a read-only date
// or claim a deadline; they stay neutral, keep the Update payment action, and never escalate to amber / alert.
describe("subscriptionBannerState - pause NOT enforced (dark / off): the owner's overdue sentence (SA-777)", () => {
  const dark = (over: Partial<SubscriptionView> = {}) => owing({ pauseEnforced: false, ...over });
  const OVERDUE =
    "Your subscription payment of $149.00 is overdue. Please complete your payment to keep your account up to date.";

  it.each([0, 3, 6, 9, 30])(
    "admin day %i: the owner's sentence with the amount and Pay now - no lock, no date, no countdown",
    (day) => {
      const s = subscriptionBannerState(dark(), "admin", at(day, 3));
      expect(s.kind).toBe("overdue");
      expect(s.tone).toBe("amber");
      expect(s.copy).toBe(OVERDUE);
      expect(s.copy).not.toMatch(/read-only|lock|suspend|tomorrow|\bby\b|Nov 8|days?\b/i);
      expect(s.action).toEqual({ label: "Pay now", intent: "pay" });
      expect(s.dismiss).toEqual({ scope: "day", key: expect.stringMatching(/^grace:in_1:/) });
      expect(s.live).toBe("status");
    },
  );

  it("the amount comes from outstandingTotal (all open invoices) over the clocked invoice's", () => {
    const s = subscriptionBannerState(dark({ outstandingTotal: 298 }), "admin", at(2));
    expect(s.copy).toContain("$298.00");
  });

  it("with the amount omitted the sentence stands without a figure (never a dash, never $0)", () => {
    const s = subscriptionBannerState(
      dark({ openInvoiceAmount: null, outstandingTotal: undefined }),
      "admin",
      at(2),
    );
    expect(s.copy).toBe(
      "Your subscription payment is overdue. Please complete your payment to keep your account up to date.",
    );
  });

  it("the Pay action carries the hosted invoice page when the server sent it", () => {
    const s = subscriptionBannerState(
      dark({ payNowUrl: "https://pay.example/in_1" }),
      "admin",
      at(2),
    );
    expect(s.action).toEqual({
      label: "Pay now",
      intent: "pay",
      url: "https://pay.example/in_1",
    });
  });

  it.each([0, 6, 30])("operator day %i: who to ask, no amount, no pay control", (day) => {
    const s = subscriptionBannerState(dark(), "staff", at(day, 3));
    expect(s.copy).toBe("Your subscription payment is overdue. Please let your admin know.");
    expect(s.action).toBeNull();
    expect(s.tone).toBe("amber");
  });

  it("no strip while a payment is processing, and none while the invoice is merely due", () => {
    expect(
      subscriptionBannerState(dark({ billingState: "processing" }), "admin", at(2)).inShell,
    ).toBe(false);
    expect(subscriptionBannerState(dark({ paymentProcessing: true }), "admin", at(2)).inShell).toBe(
      false,
    );
    expect(subscriptionBannerState(dark({ billingState: "due" }), "admin", at(2)).inShell).toBe(
      false,
    );
  });

  it("an older server that sends no flag is treated as not enforced", () => {
    const v = owing();
    delete (v as any).pauseEnforced;
    const s = subscriptionBannerState(v, "admin", at(6, 3));
    expect(s.kind).toBe("overdue");
    expect(s.copy).not.toMatch(/read-only|tomorrow/i);
  });

  it("the Billing card still offers Pay for an admin", () => {
    expect(subscriptionBannerState(dark(), "admin", at(2)).cardPay).toEqual({
      label: "Pay $149.00",
      intent: "pay",
    });
  });
});

describe("subscriptionBannerState - every amount next to Pay is the amount Pay collects (lead ruling)", () => {
  const two = (over: Partial<SubscriptionView> = {}) =>
    owing({
      pauseEnforced: false,
      outstandingTotal: 298,
      payNowAmount: 149,
      openInvoiceCount: 2,
      payNowUrl: "https://pay.example/in_1",
      ...over,
    });

  it("the overdue strip names the ONE invoice Pay collects, never the total of two", () => {
    const s = subscriptionBannerState(two(), "admin", at(2));
    expect(s.copy).toContain("payment of $149.00 is overdue");
    expect(s.copy).not.toContain("$298.00");
  });

  it("the read-only reason line uses the same source (payNowAmount)", () => {
    const text = readOnlyCopyForView(
      two({ status: "READ_ONLY", readOnlyReason: "payment_overdue", openInvoiceAmount: 298 }),
      true,
    ).text;
    expect(text).toContain("Your subscription payment of $149.00 is overdue.");
    expect(text).not.toContain("$298.00");
  });

  it("read-only while a payment settles: the reason line does not call it overdue with an amount", () => {
    const text = readOnlyCopyForView(
      two({
        status: "READ_ONLY",
        readOnlyReason: "payment_overdue",
        billingState: "processing",
        paymentProcessing: true,
        openInvoiceAmount: 149,
      }),
      true,
    ).text;
    expect(text).not.toContain("$149.00");
    expect(text).toContain("Your subscription payment is overdue.");
  });

  it("read-only while a payment is settling: no Pay anywhere (strip action or card pay)", () => {
    const s = subscriptionBannerState(
      two({
        status: "READ_ONLY",
        readOnlyReason: "payment_overdue",
        billingState: "processing",
        paymentProcessing: true,
      }),
      "admin",
      at(2),
    );
    expect(s.kind).toBe("read-only");
    expect(s.action).toBeNull();
    expect(s.cardPay).toBeNull();
  });
});

describe("subscriptionBannerState - the server's facts gate the strip (SA-777 review)", () => {
  const dark = (over: Partial<SubscriptionView> = {}) => owing({ pauseEnforced: false, ...over });

  it("a stamped marker but Stripe shows nothing open ('current'): NO strip, never '$0.00 is overdue'", () => {
    const s = subscriptionBannerState(
      dark({ billingState: "current", outstandingTotal: 0 }),
      "admin",
      at(2),
    );
    expect(s.inShell).toBe(false);
    expect(s.copy).toBe("");
  });

  it("a zero total is never printed as an amount owed", () => {
    const s = subscriptionBannerState(
      dark({ outstandingTotal: 0, openInvoiceAmount: 149 }),
      "admin",
      at(2),
    );
    expect(s.copy).not.toContain("$0.00");
    expect(s.copy).not.toContain("$149.00"); // the clocked amount is not trusted over an explicit 0
  });

  it("overdue on a live workspace with no marker stamped yet: the owner's sentence still shows", () => {
    const s = subscriptionBannerState(
      dark({
        pastDueInvoiceId: null,
        pastDueSince: null,
        billingState: "overdue",
        outstandingTotal: 149,
      }),
      "admin",
      at(2),
    );
    expect(s.kind).toBe("overdue");
    expect(s.copy).toContain("$149.00 is overdue");
    expect(s.dismiss?.key).toMatch(/^grace:open:/);
  });

  it("a read-only trial workspace is not hijacked by an open invoice's overdue state", () => {
    const s = subscriptionBannerState(
      dark({
        status: "READ_ONLY",
        readOnlyReason: "trial_expired",
        pastDueInvoiceId: null,
        pastDueSince: null,
        billingState: "overdue",
      }),
      "admin",
      at(2),
    );
    expect(s.kind).not.toBe("overdue");
  });

  it("with the pause ENFORCED a merely 'due' invoice keeps the escalation (the pause does not wait for an attempt)", () => {
    const s = subscriptionBannerState(
      owing({ pauseEnforced: true, billingState: "due" }),
      "admin",
      at(6, 2),
    );
    expect(s.kind).toBe("final-day");
  });

  it("the Pay label is the amount the link collects (one invoice), not the total of several", () => {
    const s = subscriptionBannerState(
      dark({ outstandingTotal: 298, payNowAmount: 149, payNowUrl: "https://pay.example/in_1" }),
      "admin",
      at(2),
    );
    expect(s.cardPay?.label).toBe("Pay $149.00");
  });
});

describe("subscriptionBannerState - pause enforced keeps the escalation", () => {
  it("day 6 is amber / alert / not dismissible only when the server enforces the pause", () => {
    expect(subscriptionBannerState(owing({ pauseEnforced: true }), "admin", at(6, 2)).kind).toBe(
      "final-day",
    );
    expect(subscriptionBannerState(owing({ pauseEnforced: false }), "admin", at(6, 2)).kind).toBe(
      "overdue",
    );
  });
});

// S7: a cancelled workspace that still owes an invoice is read-only because it was cancelled; paying does not
// restore it, so the sentence must not promise that.
describe("subscriptionBannerState - read-only because of a cancel, with an owed invoice (S7)", () => {
  const cancelled = (over: Partial<SubscriptionView> = {}) =>
    owing({ status: "READ_ONLY", readOnlyReason: "subscription_cancelled", ...over });

  it.each(["admin", "staff"] as const)(
    "%s: neutral line, never 'until the payment goes through'",
    (role) => {
      const s = subscriptionBannerState(cancelled(), role, at(9));
      expect(s.kind).toBe("read-only");
      // the reason line says "cancelled" and nothing promises that paying restores it
      expect(
        s.copy.startsWith(
          "This workspace is currently in read-only mode. You can view records, but changes and new transactions are temporarily unavailable. Your subscription was cancelled.",
        ),
      ).toBe(true);
      expect(s.copy).not.toMatch(/payment|goes through/i);
      expect(s.cardPay).toBeNull();
    },
  );

  it("the admin gets the Billing link, no Pay button", () => {
    const s = subscriptionBannerState(cancelled(), "admin", at(9));
    expect(s.action).toEqual({ label: "Billing", intent: "open-billing" });
    expect(subscriptionBannerState(cancelled(), "staff", at(9)).action).toBeNull();
  });
});

describe("subscriptionBannerState - an owed marker with no pastDueSince (S-nit)", () => {
  it("shows the neutral grace state, not 'Autopay is on.'", () => {
    const v = owing({ pastDueSince: null, pastDueMonthLabel: null, graceEndsLabel: null });
    const admin = subscriptionBannerState(v, "admin", at(2));
    expect(admin.kind).toBe("grace");
    expect(admin.copy).toBe("We couldn't charge your card. Update it to keep autopay running.");
    expect(admin.cardLine).toBeNull();
    expect(subscriptionBannerState(v, "staff", at(2)).kind).toBe("grace");
  });
});

// SA-775 rollout: the server says (autoLockHeld) that the pause holds every lock a banner would threaten, so nothing
// here may promise a read-only date or a deadline; the rest of the banner (the overdue sentence, Pay now) stays.
describe("subscriptionBannerState - autoLockHeld drops the lock threat", () => {
  const LOCK_WORDS = /read-only|tomorrow|nothing changes|Nov 8|suspend/i;

  it("day 6 with the pause enforced: the overdue strip, not the final-day 'read-only tomorrow'", () => {
    for (const role of ["admin", "staff"] as const) {
      const s = subscriptionBannerState(owing({ autoLockHeld: true }), role, at(6, 2));
      expect(s.kind).toBe("overdue");
      expect(s.copy).not.toMatch(LOCK_WORDS);
      expect(s.dismiss).not.toBeNull();
    }
    const admin = subscriptionBannerState(owing({ autoLockHeld: true }), "admin", at(6, 2));
    expect(admin.copy).toMatch(/overdue/i);
    expect(admin.action).toEqual({ label: "Pay now", intent: "pay" });
    expect(admin.cardPay).toEqual({ label: "Pay $149.00", intent: "pay" });
  });

  it("day 2 with the pause enforced: no 'Update it by <date> and nothing changes' deadline", () => {
    const s = subscriptionBannerState(owing({ autoLockHeld: true }), "admin", at(2));
    // owing() carries a billingState-less marker; whichever strip shows, it threatens nothing
    expect(s.copy).not.toMatch(LOCK_WORDS);
    expect(s.copy).not.toBe("");
  });

  it("false or absent: today's copy, unchanged", () => {
    for (const over of [{ autoLockHeld: false }, {}]) {
      const s = subscriptionBannerState(owing(over), "admin", at(6, 2));
      expect(s.kind).toBe("final-day");
      expect(s.copy).toBe(
        "Your workspace becomes read-only tomorrow. Update your payment to keep everything running.",
      );
      const g = subscriptionBannerState(owing(over), "admin", at(2));
      expect(g.copy).toBe(
        "We couldn't charge your card for November. Update it by Nov 8 and nothing changes.",
      );
    }
  });

  it("an already read-only workspace is untouched by the flag (that lock really happened)", () => {
    const a = subscriptionBannerState(paused({ autoLockHeld: true }), "admin", at(9));
    const b = subscriptionBannerState(paused(), "admin", at(9));
    expect(a).toEqual(b);
  });
});
