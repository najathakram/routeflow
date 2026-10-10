import { buildRefundSlip } from "./refund-slip";

/**
 * Train 4: the refund slip as a pure view model. Everything comes from GET /returns/:id (+ the business profile): header,
 * return number, the source sale, lines, the total refunded, how it was paid out (a tender, or store credit), the cashier
 * and the footer. Money is passed through as the server recorded it; nothing is re-priced here.
 */
const NOW = new Date("2026-10-09T15:30:00Z");
const RET = {
  id: "r1",
  returnNumber: "RET-7",
  kind: "INLINE",
  status: "REFUNDED",
  order: { id: "o1", orderNumber: "ORD-1", counterSale: true },
  items: [
    { id: "i1", product: { id: "p1", name: "Cola" }, qty: 2, unitPrice: 2.5 },
    { id: "i2", product: { id: "p2", name: "Water" }, qty: 1, unitPrice: null },
  ],
  refundAmount: 5,
  refundMethod: "EXTERNAL_REFUND",
  refundTender: "CARD",
  refundedAt: "2026-10-09T14:00:00Z",
  createdAt: "2026-10-09T13:00:00Z",
};
const build = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  buildRefundSlip({
    ret: { ...RET, ...over } as never,
    profile: {
      businessName: "Acme Foods",
      street: "1 Main St",
      city: "Austin",
      state: "TX",
      zip: "78701",
      phone: "555-0100",
    },
    printedBy: " pat ",
    now: NOW,
    ...extra,
  });

describe("buildRefundSlip", () => {
  it("carries the header, return number, source sale and who printed it", () => {
    const m = build();
    expect(m.header.name).toBe("Acme Foods");
    expect(m.header.addressLines).toEqual(["1 Main St", "Austin, TX 78701"]);
    expect(m.returnNumber).toBe("RET-7");
    expect(m.sourceSale).toBe("Counter sale ORD-1");
    expect(m.printedBy).toBe("pat");
  });

  it("a delivered (non-counter) order reads as Order N", () => {
    expect(
      build({ order: { id: "o2", orderNumber: "ORD-9", counterSale: false } }).sourceSale,
    ).toBe("Order ORD-9");
    expect(build({ order: undefined }).sourceSale).toBeNull();
  });

  it("lists each line with its quantity, and the price only when the return stored one", () => {
    const m = build();
    expect(m.lines).toEqual([
      { key: "i1", name: "Cola", detail: "2 × $2.50" },
      { key: "i2", name: "Water", detail: "1" },
    ]);
  });

  it("a tendered refund names the tender and the total", () => {
    const m = build();
    expect(m.total).toBe(5);
    expect(m.payout).toEqual({ kind: "TENDER", label: "Refunded to Card", amount: 5 });
  });

  it.each([
    ["CASH", "Refunded to Cash"],
    ["CHECK", "Refunded to Check"],
  ])("tender %s", (tender, label) => {
    expect((build({ refundTender: tender }).payout as { label: string }).label).toBe(label);
  });

  it("a refund with no recorded tender says Refunded, not a guessed tender", () => {
    expect(build({ refundTender: null }).payout).toEqual({
      kind: "TENDER",
      label: "Refunded",
      amount: 5,
    });
  });

  it("store credit names the credit note", () => {
    const m = build({
      refundMethod: "CREDIT_NOTE",
      refundTender: null,
      creditNote: { id: "cn1", creditNoteNumber: "CN-12", amount: 5, status: "ISSUED" },
    });
    expect(m.payout).toEqual({ kind: "STORE_CREDIT", label: "Store credit CN-12", amount: 5 });
  });

  it("the footer is the business's own text, trimmed; none when blank", () => {
    expect(build({}, { profile: { receiptFooter: "  Thanks!  " } }).footer).toBe("Thanks!");
    expect(build({}, { profile: { receiptFooter: "   " } }).footer).toBeNull();
    expect(build({}, { profile: null }).footer).toBeNull();
  });

  it("dates the slip with the refund time in the business zone, falling back to the return's creation", () => {
    const m = build({}, { profile: { timezone: "UTC" } });
    expect(m.dateLabel).toMatch(/2026/);
    expect(m.dateLabel).toMatch(/2:00/); // 14:00 UTC
    expect(build({ refundedAt: null }, { profile: { timezone: "UTC" } }).dateLabel).toMatch(/1:00/);
  });

  it("a PENDING inline refund (RECEIVED, EXTERNAL_REFUND, no amount, no refundedAt) has no payout, never 'Refunded $0.00'", () => {
    const m = build({
      status: "RECEIVED",
      refundMethod: "EXTERNAL_REFUND",
      refundTender: null,
      refundAmount: null,
      refundedAt: null,
    });
    expect(m.payout).toEqual({ kind: "NONE" });
    expect(m.total).toBe(0);
  });

  it.each([
    ["status is not REFUNDED", { status: "APPROVED" }],
    ["there is no refund amount", { refundAmount: null }],
    ["there is no refundedAt", { refundedAt: null }],
  ])("no payout when %s", (_n, over) => {
    expect(build(over as Record<string, unknown>).payout).toEqual({ kind: "NONE" });
  });

  it("an unrefunded return has no payout yet (the slip is for a settled refund)", () => {
    expect(
      build({ status: "RECEIVED", refundAmount: null, refundMethod: null, refundTender: null })
        .payout.kind,
    ).toBe("NONE");
  });
});
