import type { PaymentDueView } from "@routeflow/types";
import {
  cardReminderCopy,
  cardReminderDismiss,
  failedRenewalCopy,
  paymentDueCopy,
  shownTermsOf,
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
  cardBy: null,
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

describe("shownTermsOf (row 542c): the terms the pay click sends back", () => {
  it("a bill: the amount and period it displayed, no card deadline", () => {
    expect(shownTermsOf(due())).toEqual({
      amountCents: 10_000,
      periodStart: "2026-10-01T00:00:00.000Z",
      cardBy: null,
    });
  });

  it("an Add card banner: $0, no period, the card deadline it displayed", () => {
    expect(
      shownTermsOf(
        due({
          due: false,
          pastDue: false,
          amountCents: 0,
          periodLabel: null,
          periodStart: null,
          cardNeeded: true,
          chargeStartsOn: "2026-11-01T12:00:00.000Z",
          cardBy: "2026-10-29T12:00:00.000Z",
        }),
      ),
    ).toEqual({ amountCents: 0, periodStart: null, cardBy: "2026-10-29T12:00:00.000Z" });
  });

  it("carries only the three terms (nothing else rides along to the server)", () => {
    expect(Object.keys(shownTermsOf(due())).sort()).toEqual([
      "amountCents",
      "cardBy",
      "periodStart",
    ]);
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

// SA-801 + SA-806: the card reminder for a catch-up with nothing charged now. A is the first charge; D = cardBy is
// the card deadline (A - 72 h, the last instant the quoted terms hold). The title prints D, the body prints A.
const A = "2026-11-01T12:00:00.000Z";
const CARD_BY = "2026-10-29T12:00:00.000Z";
const D_MS = Date.parse(CARD_BY);
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
    cardBy: CARD_BY,
    ...over,
  });

describe("cardReminderCopy", () => {
  it("admin: the owner's title with the card deadline D, the no-charge body with A, Add card + View billing", () => {
    const c = cardReminderCopy(reminder(), "admin", "America/New_York")!;
    expect(c.kind).toBe("card-reminder");
    expect(c.title).toBe("Add your card before October 29, 2026 to keep RouteFlow running.");
    expect(c.body).toBe("You won't be charged until November 1, 2026.");
    expect(c.primary).toEqual({ label: "Add card", intent: "pay" });
    expect(c.secondary).toEqual({ label: "View billing", href: "/settings/billing" });
    expect(c.note).toBeNull();
  });

  it("operator: no control, asks the account admin to add a card before D", () => {
    const c = cardReminderCopy(reminder(), "staff", "America/New_York")!;
    expect(c.primary).toBeNull();
    expect(c.note).toBe("Ask your account admin to add a card before October 29, 2026.");
    expect(c.title).toBe("Add your card before October 29, 2026 to keep RouteFlow running.");
    expect(c.body).toBe("You won't be charged until November 1, 2026.");
  });

  it("prints each date's calendar day in the tenant's zone (the same instant is a different day elsewhere)", () => {
    const late = reminder({
      cardBy: "2026-10-29T03:00:00.000Z",
      chargeStartsOn: "2026-11-01T03:00:00.000Z",
    });
    const la = cardReminderCopy(late, "admin", "America/Los_Angeles")!;
    expect(la.title).toContain("October 28, 2026");
    expect(la.body).toContain("October 31, 2026");
    const utc = cardReminderCopy(late, "admin", "UTC")!;
    expect(utc.title).toContain("October 29, 2026");
    expect(utc.body).toContain("November 1, 2026");
  });

  it("R5 (guard): the printed deadline is D's own day in the zone, never a later one (east of UTC or west)", () => {
    const longDay = (ms: number, zone: string) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        year: "numeric",
        month: "long",
        day: "numeric",
      }).format(new Date(ms));
    const zones = [
      "UTC",
      "America/Los_Angeles",
      "Pacific/Pago_Pago",
      "Asia/Kolkata",
      "Pacific/Auckland",
      "Pacific/Kiritimati",
    ];
    for (const zone of zones) {
      for (const d of [D_MS, D_MS - 11 * 3600_000, D_MS + 13 * 3600_000]) {
        const copy = cardReminderCopy(
          reminder({ cardBy: new Date(d).toISOString() }),
          "admin",
          zone,
        )!;
        expect(copy.title).toBe(
          `Add your card before ${longDay(d, zone)} to keep RouteFlow running.`,
        );
      }
    }
    // Auckland (UTC+13 in October): D = Oct 29 12:00Z is already Oct 30 there. "Before October 30" ends at
    // 00:00 NZDT = Oct 29 11:00Z, one hour before D: never later than D.
    const nz = cardReminderCopy(reminder(), "admin", "Pacific/Auckland")!;
    expect(nz.title).toContain("October 30, 2026");
    // The same fact as a PROPERTY (derived, not a constant): the instant the printed day STARTS in the zone is
    // never later than D, for every zone and several D. Fails if the printer used a zone east of the tenant's.
    const MONTHS = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];
    const dayKey = (ms: number, zone: string) =>
      Number(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: zone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .format(new Date(ms))
          .replace(/-/g, ""),
      );
    /** The first instant whose calendar day in `zone` is the printed day (binary search on the monotonic day key). */
    const startOfPrintedDay = (printed: string, zone: string): number => {
      const m = /^([A-Za-z]+) (\d+), (\d{4})$/.exec(printed)!;
      const target = Number(m[3]) * 10000 + (MONTHS.indexOf(m[1]) + 1) * 100 + Number(m[2]);
      const mid = Date.UTC(Number(m[3]), MONTHS.indexOf(m[1]), Number(m[2]));
      let lo = mid - 36 * 3600_000; // before the day starts anywhere on earth
      let hi = mid + 36 * 3600_000; // after it has started everywhere
      while (hi - lo > 1) {
        const m2 = Math.floor((lo + hi) / 2);
        if (dayKey(m2, zone) >= target) hi = m2;
        else lo = m2;
      }
      return hi;
    };
    for (const zone of zones) {
      for (const d of [D_MS, D_MS - 11 * 3600_000, D_MS + 13 * 3600_000]) {
        const title = cardReminderCopy(
          reminder({ cardBy: new Date(d).toISOString() }),
          "admin",
          zone,
        )!.title;
        const printed = /^Add your card before (.+) to keep RouteFlow running\.$/.exec(title)![1];
        expect(startOfPrintedDay(printed, zone)).toBeLessThanOrEqual(d);
      }
    }
    // A is not the deadline: the Auckland body prints A's own day
    expect(nz.body).toBe("You won't be charged until November 2, 2026.");
  });

  it("null unless the server asked for it, or when either date is unusable", () => {
    expect(cardReminderCopy(reminder({ cardNeeded: false }), "admin", "UTC")).toBeNull();
    expect(cardReminderCopy(reminder({ chargeStartsOn: null }), "admin", "UTC")).toBeNull();
    expect(cardReminderCopy(reminder({ chargeStartsOn: "not a date" }), "admin", "UTC")).toBeNull();
    expect(cardReminderCopy(reminder({ cardBy: null }), "admin", "UTC")).toBeNull();
    expect(cardReminderCopy(reminder({ cardBy: "not a date" }), "admin", "UTC")).toBeNull();
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

describe("cardReminderDismiss: dismissible for the day until 7 days before cardBy (SA-806)", () => {
  it("both roles can dismiss it for the day when cardBy is more than 7 days out", () => {
    const now = D_MS - 8 * DAY;
    for (const role of ["admin", "staff"] as const) {
      expect(cardReminderDismiss(reminder(), role, now)).toEqual({
        scope: "day",
        key: `card-reminder:${CARD_BY}`,
      });
    }
  });

  it("the admin cannot dismiss from exactly 7 days before cardBy, nor after; the operator still can, daily", () => {
    for (const now of [D_MS - 7 * DAY, D_MS - 3 * DAY, D_MS - 1000, D_MS + 3600_000]) {
      expect(cardReminderDismiss(reminder(), "admin", now)).toBeNull();
      expect(cardReminderDismiss(reminder(), "staff", now)).toEqual({
        scope: "day",
        key: `card-reminder:${CARD_BY}`,
      });
    }
  });

  it("R3: an admin at cardBy - 7 days + 1 minute cannot dismiss (master: the lock began 3 days later); an operator can", () => {
    const now = D_MS - 7 * DAY + 60_000;
    expect(cardReminderDismiss(reminder(), "admin", now)).toBeNull();
    expect(cardReminderDismiss(reminder(), "staff", now)).toEqual({
      scope: "day",
      key: `card-reminder:${CARD_BY}`,
    });
  });

  it("one second before the 7-day mark the admin still can", () => {
    expect(cardReminderDismiss(reminder(), "admin", D_MS - 7 * DAY - 1000)).not.toBeNull();
  });

  it("no card-needed read (or no cardBy), nothing to dismiss", () => {
    expect(cardReminderDismiss(reminder({ cardNeeded: false }), "staff", D_MS)).toBeNull();
    expect(cardReminderDismiss(reminder({ cardBy: null }), "staff", D_MS)).toBeNull();
    expect(cardReminderDismiss(null, "staff", D_MS)).toBeNull();
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
    expect(
      paymentDueSlot(
        strip("none", false),
        due({ cardNeeded: true, chargeStartsOn: A, cardBy: CARD_BY }),
      ),
    ).toBe("payment-due");
  });

  it("a failed renewal (grace, overdue) keeps its own banner", () => {
    expect(paymentDueSlot(strip("grace"), reminder())).toBe("failed-renewal");
    expect(paymentDueSlot(strip("overdue"), reminder())).toBe("failed-renewal");
  });

  it("an unusable date (A or cardBy) or no cardNeeded: the strip slot", () => {
    expect(paymentDueSlot(strip("none", false), reminder({ cardBy: null }))).toBe("strip");
    expect(paymentDueSlot(strip("none", false), reminder({ cardBy: "nope" }))).toBe("strip");
    expect(paymentDueSlot(strip("none", false), reminder({ chargeStartsOn: null }))).toBe("strip");
    expect(paymentDueSlot(strip("none", false), reminder({ chargeStartsOn: "nope" }))).toBe(
      "strip",
    );
    expect(paymentDueSlot(strip("none", false), reminder({ cardNeeded: false }))).toBe("strip");
  });
});
