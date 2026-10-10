import type { SubscriptionView } from "@routeflow/types";
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
    billingContactName: "Dana",
    pastDueSince: null,
    pastDueInvoiceId: null,
    openInvoiceAmount: null,
    paymentMethodSummary: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2027 },
    nextCharge: { amount: 149, date: "2026-12-01T12:00:00.000Z" },
    ...over,
  };
}

const owing = (over: Partial<SubscriptionView> = {}) =>
  view({
    pastDueSince: T0.toISOString(),
    pastDueInvoiceId: "in_1",
    openInvoiceAmount: 149,
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
      "There's a billing issue. Everything still works. Dana can sort it out in Billing.",
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

  it("no contact on file: 'your admin' (lower case mid-sentence, 'Your admin' at a sentence start)", () => {
    const s = subscriptionBannerState(owing({ billingContactName: null }), "staff", at(1));
    expect(s.copy).toBe(
      "There's a billing issue. Everything still works. Your admin can sort it out in Billing.",
    );
    const d6 = subscriptionBannerState(owing({ billingContactName: null }), "staff", at(6, 2));
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
    expect(s.copy).toBe("Your workspace becomes read-only tomorrow. Let Dana know.");
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
    expect(s.copy).toBe(
      "Your workspace is read-only until the November payment of $149.00 goes through. Your data is safe.",
    );
    expect(s.action).toEqual({ label: "Pay $149.00", intent: "pay" });
    expect(s.cardPay).toEqual({ label: "Pay $149.00", intent: "pay" });
    expect(s.dismiss).toBeNull();
    expect(s.live).toBe("alert");
    expect(s.inShell).toBe(true);
  });

  it("operator: view, print and export are named; the admin can restore it; no action", () => {
    const s = subscriptionBannerState(paused(), "staff", at(8));
    expect(s.copy).toBe(
      "Your workspace is read-only. You can still view, print and export. Dana can restore it.",
    );
    expect(s.action).toBeNull();
    expect(s.cardPay).toBeNull();
    expect(s.dismiss).toBeNull();
  });

  it("an unreadable invoice amount never prints a dash: the money is simply left out", () => {
    const s = subscriptionBannerState(paused({ openInvoiceAmount: null }), "admin", at(8));
    expect(s.copy).toBe(
      "Your workspace is read-only until the November payment goes through. Your data is safe.",
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
      expect(text).not.toMatch(/overdue|failed|suspend|choose a plan|subscribe|countdown/i);
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
  it("is the exact blocked-control sentence", () => {
    expect(readOnlyLine("Dana")).toBe("Not available while read-only. Dana can restore it.");
    expect(readOnlyLine(null)).toBe("Not available while read-only. Your admin can restore it.");
    expect(readOnlyLine(undefined)).toBe(
      "Not available while read-only. Your admin can restore it.",
    );
  });
});
