import type { PaymentDueView } from "@routeflow/types";
import {
  cardReminderCopy,
  cardReminderDismiss,
  failedRenewalCopy,
  paymentDueCopy,
} from "./payment-due";
import { paymentDueSlot, type BannerState } from "./subscription-banner-state";

const due = (over: Partial<PaymentDueView> = {}): PaymentDueView => ({
  due: true,
  pastDue: true,
  amountCents: 10_000,
  periodLabel: "October 2026",
  periodStart: "2026-10-01T00:00:00.000Z",
  cardNeeded: false,
  chargeStartsOn: null,
  ...over,
});

const NO_DASH = /[–—]/;

describe("paymentDueCopy", () => {
  it("past due, admin: title, body with the formatted amount and period, Pay now + View billing", () => {
    const c = paymentDueCopy(due(), "admin")!;
    expect(c.kind).toBe("past-due");
    expect(c.title).toBe("Your payment is past due.");
    expect(c.body).toBe("Pay $100.00 for your October 2026 subscription to keep using RouteFlow.");
    expect(c.primary).toEqual({ label: "Pay now", intent: "pay" });
    expect(c.secondary).toEqual({ label: "View billing", href: "/settings/billing" });
    expect(c.note).toBeNull();
  });

  it("due (not yet past due), admin", () => {
    const c = paymentDueCopy(due({ pastDue: false }), "admin")!;
    expect(c.kind).toBe("due");
    expect(c.title).toBe("Your payment is due.");
    expect(c.primary?.label).toBe("Pay now");
  });

  it("operator: no pay control, the ask-your-admin line instead", () => {
    const c = paymentDueCopy(due(), "staff")!;
    expect(c.primary).toBeNull();
    expect(c.note).toBe("Ask your account admin to pay.");
    expect(c.body).toBe("Pay $100.00 for your October 2026 subscription to keep using RouteFlow.");
    expect(c.secondary).toEqual({ label: "View billing", href: "/settings/billing" });
  });

  it("prints cents exactly (12345 cents is $123.45)", () => {
    expect(paymentDueCopy(due({ amountCents: 12_345 }), "admin")!.body).toContain("$123.45");
  });

  it("not due, or a figure that is not payable: null", () => {
    expect(paymentDueCopy(due({ due: false }), "admin")).toBeNull();
    expect(paymentDueCopy(due({ amountCents: 0 }), "admin")).toBeNull();
    expect(paymentDueCopy(due({ amountCents: 10.5 }), "admin")).toBeNull();
    expect(paymentDueCopy(null, "admin")).toBeNull();
    expect(paymentDueCopy(undefined, "admin")).toBeNull();
  });

  it("a missing period label drops the period words, never prints null", () => {
    const c = paymentDueCopy(due({ periodLabel: null }), "admin")!;
    expect(c.body).toBe("Pay $100.00 for your subscription to keep using RouteFlow.");
  });

  it("no em or en dash anywhere in the copy", () => {
    for (const role of ["admin", "staff"] as const) {
      for (const c of [
        paymentDueCopy(due(), role),
        paymentDueCopy(due({ pastDue: false }), role),
        failedRenewalCopy(role),
      ]) {
        expect(JSON.stringify(c)).not.toMatch(NO_DASH);
      }
    }
  });
});

describe("failedRenewalCopy", () => {
  it("admin: title, body, Update card", () => {
    const c = failedRenewalCopy("admin");
    expect(c.kind).toBe("failed-renewal");
    expect(c.title).toBe("Your last payment didn't go through.");
    expect(c.body).toBe("Update your card to keep using RouteFlow.");
    expect(c.primary).toEqual({ label: "Update card", intent: "update-card" });
    expect(c.secondary).toEqual({ label: "View billing", href: "/settings/billing" });
  });

  it("operator: no Update card, asks the admin", () => {
    const c = failedRenewalCopy("staff");
    expect(c.primary).toBeNull();
    expect(c.note).toBe("Ask your account admin to update the card.");
  });
});

describe("paymentDueSlot", () => {
  const strip = (kind: BannerState["kind"], inShell = true): BannerState =>
    ({
      kind,
      tone: "amber",
      copy: "x",
      action: null,
      dismiss: null,
      live: null,
      inShell,
      cardLine: null,
      cardPay: null,
    }) as BannerState;

  it("a payment due wins over a quiet or grace strip", () => {
    expect(paymentDueSlot(strip("none", false), due())).toBe("payment-due");
    expect(paymentDueSlot(strip("grace"), due())).toBe("payment-due");
    expect(paymentDueSlot(strip("card-expiring"), due())).toBe("payment-due");
  });

  it("final-day and read-only keep the strip even when a payment is due", () => {
    expect(paymentDueSlot(strip("final-day"), due())).toBe("strip");
    expect(paymentDueSlot(strip("read-only"), due())).toBe("strip");
  });

  it("grace and overdue become the failed-renewal variant when nothing is due", () => {
    expect(paymentDueSlot(strip("grace"), undefined)).toBe("failed-renewal");
    expect(paymentDueSlot(strip("overdue"), due({ due: false }))).toBe("failed-renewal");
  });

  it("final-day and read-only are never replaced by the failed-renewal variant", () => {
    expect(paymentDueSlot(strip("final-day"), null)).toBe("strip");
    expect(paymentDueSlot(strip("read-only"), null)).toBe("strip");
  });

  it("nothing due and no strip: the strip slot (which renders nothing)", () => {
    expect(paymentDueSlot(strip("none", false), undefined)).toBe("strip");
    expect(paymentDueSlot(strip("autopay", false), due({ due: false }))).toBe("strip");
  });

  it("a due payment with an unpayable figure does not take the slot", () => {
    expect(paymentDueSlot(strip("none", false), due({ amountCents: 0 }))).toBe("strip");
  });
});

// SA-801: the card reminder for a stub-free catch-up (nothing owed now, the card is needed before A).
const A = "2026-11-01T12:00:00.000Z";
const A_MS = Date.parse(A);
const DAY = 86_400_000;
const reminder = (over: Partial<PaymentDueView> = {}): PaymentDueView =>
  due({
    due: false,
    pastDue: false,
    amountCents: 0,
    periodLabel: null,
    periodStart: null,
    cardNeeded: true,
    chargeStartsOn: A,
    ...over,
  });

describe("cardReminderCopy", () => {
  it("admin: the owner's title, the no-charge body, Add card + View billing", () => {
    const c = cardReminderCopy(reminder(), "admin", "America/New_York")!;
    expect(c.kind).toBe("card-reminder");
    expect(c.title).toBe("Add your card before November 1, 2026 to keep RouteFlow running.");
    expect(c.body).toBe("You won't be charged until November 1, 2026.");
    expect(c.primary).toEqual({ label: "Add card", intent: "pay" });
    expect(c.secondary).toEqual({ label: "View billing", href: "/settings/billing" });
    expect(c.note).toBeNull();
  });

  it("operator: no control, asks the account admin with the same date", () => {
    const c = cardReminderCopy(reminder(), "staff", "America/New_York")!;
    expect(c.primary).toBeNull();
    expect(c.note).toBe("Ask your account admin to add a card before November 1, 2026.");
    expect(c.title).toBe("Add your card before November 1, 2026 to keep RouteFlow running.");
  });

  it("prints A's calendar day in the tenant's zone (the same instant is a different day elsewhere)", () => {
    const late = reminder({ chargeStartsOn: "2026-11-01T03:00:00.000Z" });
    expect(cardReminderCopy(late, "admin", "America/Los_Angeles")!.title).toContain(
      "October 31, 2026",
    );
    expect(cardReminderCopy(late, "admin", "UTC")!.title).toContain("November 1, 2026");
  });

  it("null unless the server asked for it, or when the date is unusable", () => {
    expect(cardReminderCopy(reminder({ cardNeeded: false }), "admin", "UTC")).toBeNull();
    expect(cardReminderCopy(reminder({ chargeStartsOn: null }), "admin", "UTC")).toBeNull();
    expect(cardReminderCopy(reminder({ chargeStartsOn: "not a date" }), "admin", "UTC")).toBeNull();
    expect(cardReminderCopy(null, "admin", "UTC")).toBeNull();
    expect(cardReminderCopy(undefined, "admin", "UTC")).toBeNull();
    // a bill that is due is the payment-due banner's, never this one
    expect(cardReminderCopy(reminder({ due: true }), "admin", "UTC")).toBeNull();
  });

  it("no em or en dash anywhere in the copy", () => {
    for (const role of ["admin", "staff"] as const) {
      expect(JSON.stringify(cardReminderCopy(reminder(), role, "UTC"))).not.toMatch(NO_DASH);
    }
  });
});

describe("cardReminderDismiss: dismissible for the day until 7 days before A", () => {
  it("both roles can dismiss it for the day when A is more than 7 days out", () => {
    const now = A_MS - 8 * DAY;
    for (const role of ["admin", "staff"] as const) {
      expect(cardReminderDismiss(reminder(), role, now)).toEqual({
        scope: "day",
        key: `card-reminder:${A}`,
      });
    }
  });

  it("the admin cannot dismiss from exactly 7 days before A, nor after; the operator still can, daily", () => {
    for (const now of [A_MS - 7 * DAY, A_MS - 3 * DAY, A_MS - 1000, A_MS + DAY]) {
      expect(cardReminderDismiss(reminder(), "admin", now)).toBeNull();
      expect(cardReminderDismiss(reminder(), "staff", now)).toEqual({
        scope: "day",
        key: `card-reminder:${A}`,
      });
    }
  });

  it("one second before the 7-day mark the admin still can", () => {
    expect(cardReminderDismiss(reminder(), "admin", A_MS - 7 * DAY - 1000)).not.toBeNull();
  });

  it("no card-needed read, nothing to dismiss", () => {
    expect(cardReminderDismiss(reminder({ cardNeeded: false }), "staff", A_MS)).toBeNull();
    expect(cardReminderDismiss(null, "staff", A_MS)).toBeNull();
  });
});

describe("paymentDueSlot: the card reminder", () => {
  const strip = (kind: BannerState["kind"], inShell = true): BannerState =>
    ({
      kind,
      tone: "amber",
      copy: "x",
      action: null,
      dismiss: null,
      live: null,
      inShell,
      cardLine: null,
      cardPay: null,
    }) as BannerState;

  it("sits above the quiet strip", () => {
    expect(paymentDueSlot(strip("none", false), reminder())).toBe("card-reminder");
    expect(paymentDueSlot(strip("autopay", false), reminder())).toBe("card-reminder");
    expect(paymentDueSlot(strip("card-expiring"), reminder())).toBe("card-reminder");
  });

  it("final-day and read-only keep the strip", () => {
    expect(paymentDueSlot(strip("final-day"), reminder())).toBe("strip");
    expect(paymentDueSlot(strip("read-only"), reminder())).toBe("strip");
  });

  it("a payable payment due still wins (the two cannot coexist, but the order is fixed)", () => {
    expect(paymentDueSlot(strip("none", false), due({ cardNeeded: true, chargeStartsOn: A }))).toBe(
      "payment-due",
    );
  });

  it("a failed renewal (grace, overdue) keeps its own banner", () => {
    expect(paymentDueSlot(strip("grace"), reminder())).toBe("failed-renewal");
    expect(paymentDueSlot(strip("overdue"), reminder())).toBe("failed-renewal");
  });

  it("an unusable date or no cardNeeded: the strip slot", () => {
    expect(paymentDueSlot(strip("none", false), reminder({ chargeStartsOn: null }))).toBe("strip");
    expect(paymentDueSlot(strip("none", false), reminder({ chargeStartsOn: "nope" }))).toBe(
      "strip",
    );
    expect(paymentDueSlot(strip("none", false), reminder({ cardNeeded: false }))).toBe("strip");
  });
});
