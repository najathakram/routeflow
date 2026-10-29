import { buildCounterSaleResponse, checkReferenceOf } from "./counter-sale-readback";
import { toTodaysSaleRow, type TodayOrderRecord } from "./counter-sale-today";

/**
 * W-713 / F11: the check number typed at the till (`Payment.reference`) rides back on the sale response and the Today's-sales
 * row so the receipt and the reprint read "Check #1042". Fixtures are placeholders (acme).
 */
const inv = (payments: Array<Record<string, unknown>>) => ({
  id: "inv-1",
  invoiceNumber: "INV-00001",
  total: "25.00",
  items: [],
  payments,
});
const response = (payments: Array<Record<string, unknown>>) =>
  buildCounterSaleResponse({
    order: { id: "o1", orderNumber: "ORD-00001", counterCashTendered: null, tax: "0" },
    invoices: [inv(payments)] as never,
    replayed: false,
    configuredTaxPercent: null,
  });
const check = (reference: string | null, over: Record<string, unknown> = {}) => ({
  id: "p1",
  amount: "25.00",
  method: "CHECK",
  status: "PAID",
  reference,
  ...over,
});

describe("checkReferenceOf", () => {
  it("is the trimmed number of the first live CHECK tender", () => {
    expect(checkReferenceOf([check(" 1042 ")])).toBe("1042");
  });
  it("is undefined with no number, no check tender, or only a voided check", () => {
    expect(checkReferenceOf([check(null)])).toBeUndefined();
    expect(checkReferenceOf([check("  ")])).toBeUndefined();
    expect(checkReferenceOf([check("1042", { method: "CASH" })])).toBeUndefined();
    expect(checkReferenceOf([check("1042", { status: "VOID" })])).toBeUndefined();
  });
});

describe("counter-sale response: checkReference", () => {
  it("serves the check number on a check sale", () => {
    expect(response([check("1042")]).checkReference).toBe("1042");
  });
  it("omits it for a card or cash sale, and for a check with no number", () => {
    expect(response([check("4111", { method: "CREDIT_CARD" })])).not.toHaveProperty(
      "checkReference",
    );
    expect(response([check(null)])).not.toHaveProperty("checkReference");
  });
});

describe("Today's sales row: checkReference", () => {
  const order = (payments: Array<Record<string, unknown>>) =>
    ({
      id: "o-1",
      orderNumber: "ORD-00001",
      status: "DELIVERED",
      total: "25.00",
      createdAt: new Date("2026-10-07T18:14:00.000Z"),
      customerId: "c-1",
      customer: { businessName: "Acme Test Customer", isWalkIn: false },
      invoices: [{ id: "i-1", invoiceNumber: "INV-1", status: "PAID", payments }],
      returns: [],
    }) as unknown as TodayOrderRecord;

  it("serves the check number so the reprint can print it", () => {
    expect(toTodaysSaleRow(order([check("1042")])).checkReference).toBe("1042");
  });
  it("omits it when the sale has no numbered check", () => {
    const cash = check("1042", { method: "CASH" });
    expect(toTodaysSaleRow(order([cash]))).not.toHaveProperty("checkReference");
  });
});
