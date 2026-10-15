import type { PaymentDueView } from "@routeflow/types";
import { paymentDueCopy, failedRenewalCopy } from "./payment-due";
import { paymentDueSlot, type BannerState } from "./subscription-banner-state";

const due = (over: Partial<PaymentDueView> = {}): PaymentDueView => ({
  due: true,
  pastDue: true,
  amountCents: 10_000,
  periodLabel: "October 2026",
  periodStart: "2026-10-01T00:00:00.000Z",
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
