import {
  deriveBillingState,
  outstandingCents,
  owedInvoices,
  type OpenInvoiceFact,
} from "./billing-state";

const NOW = new Date("2026-10-15T12:00:00Z");
const nowSec = NOW.getTime() / 1000;
const inv = (over: Partial<OpenInvoiceFact> = {}): OpenInvoiceFact => ({
  amountRemainingCents: 14900,
  attemptCount: 0,
  dueDateSec: null,
  paymentProcessing: false,
  hostedInvoiceUrl: "https://pay.example/in_1",
  createdSec: nowSec - 86_400,
  ...over,
});

describe("deriveBillingState (SA-777): processing > overdue > due > current", () => {
  it("nothing open is current", () => {
    expect(deriveBillingState([], NOW)).toBe("current");
  });

  it("an open invoice with nothing remaining owes nothing: current", () => {
    expect(deriveBillingState([inv({ amountRemainingCents: 0, attemptCount: 3 })], NOW)).toBe(
      "current",
    );
  });

  it("owed and never attempted, not past due: due", () => {
    expect(deriveBillingState([inv()], NOW)).toBe("due");
    expect(deriveBillingState([inv({ dueDateSec: nowSec + 86_400 })], NOW)).toBe("due");
  });

  it("a failed attempt (attempt_count > 0) is overdue", () => {
    expect(deriveBillingState([inv({ attemptCount: 1 })], NOW)).toBe("overdue");
  });

  it("past its own due_date is overdue even with no attempt", () => {
    expect(deriveBillingState([inv({ dueDateSec: nowSec - 1 })], NOW)).toBe("overdue");
  });

  it("a payment still processing beats overdue and due", () => {
    expect(deriveBillingState([inv({ paymentProcessing: true, attemptCount: 2 })], NOW)).toBe(
      "processing",
    );
    expect(deriveBillingState([inv({ paymentProcessing: true })], NOW)).toBe("processing");
  });

  it("the worst invoice wins across several", () => {
    expect(deriveBillingState([inv(), inv({ attemptCount: 1 })], NOW)).toBe("overdue");
    expect(
      deriveBillingState([inv({ attemptCount: 1 }), inv({ paymentProcessing: true })], NOW),
    ).toBe("processing");
  });

  it("a processing flag on an invoice that owes nothing does not count", () => {
    expect(
      deriveBillingState([inv({ amountRemainingCents: 0, paymentProcessing: true })], NOW),
    ).toBe("current");
  });
});

describe("outstandingCents / owedInvoices", () => {
  it("sums integer cents across the owed invoices only, oldest first", () => {
    const list = [
      inv({ amountRemainingCents: 4999, createdSec: 300 }),
      inv({ amountRemainingCents: 0, createdSec: 100 }),
      inv({ amountRemainingCents: 10001, createdSec: 200 }),
    ];
    expect(outstandingCents(list)).toBe(15000);
    expect(owedInvoices(list).map((i) => i.createdSec)).toEqual([200, 300]);
  });

  it("is exact where float dollars are not (0.1 + 0.2 cents-wise)", () => {
    expect(
      outstandingCents([inv({ amountRemainingCents: 10 }), inv({ amountRemainingCents: 20 })]),
    ).toBe(30);
  });
});
