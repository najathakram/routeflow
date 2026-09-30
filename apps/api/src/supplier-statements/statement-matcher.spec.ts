import { matchStatementLines, type MatchableBill } from "./statement-matcher";
import type { ParsedStatementLine } from "./dto/statement.dto";

const line = (overrides: Partial<ParsedStatementLine> = {}): ParsedStatementLine => ({
  date: "2026-08-01",
  kind: "INVOICE",
  refNumber: null,
  amount: 250,
  runningBalance: null,
  ...overrides,
});

const bill = (overrides: Partial<MatchableBill> = {}): MatchableBill => ({
  id: "bill-1",
  billNumber: "BILL-2026-0001",
  supplierInvoiceNumber: null,
  totalOwed: 250,
  billDate: new Date("2026-08-01T00:00:00.000Z"),
  status: "RECEIVED",
  ...overrides,
});

describe("matchStatementLines", () => {
  it("pre-checks an exact-ref match whose amount also agrees", () => {
    const lines = [line({ refNumber: "INV100", amount: 250 })];
    const bills = [bill({ id: "b1", supplierInvoiceNumber: "INV100", totalOwed: 250 })];

    const [match] = matchStatementLines(lines, bills);

    expect(match.tier).toBe("EXACT_REF");
    expect(match.billId).toBe("b1");
    expect(match.preChecked).toBe(true);
  });

  it("matches an exact ref whose amount disagrees, but does NOT pre-check it", () => {
    const lines = [line({ refNumber: "INV100", amount: 999 })];
    const bills = [bill({ id: "b1", supplierInvoiceNumber: "INV100", totalOwed: 250 })];

    const [match] = matchStatementLines(lines, bills);

    expect(match.tier).toBe("EXACT_REF");
    expect(match.billId).toBe("b1");
    expect(match.preChecked).toBe(false);
  });

  it("matches a fuzzy candidate (amount + date within window) but never pre-checks it", () => {
    const lines = [line({ refNumber: null, date: "2026-08-02", amount: 250 })];
    const bills = [
      bill({
        id: "b1",
        supplierInvoiceNumber: null,
        totalOwed: 250.003,
        billDate: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ];

    const [match] = matchStatementLines(lines, bills);

    expect(match.tier).toBe("FUZZY");
    expect(match.billId).toBe("b1");
    expect(match.preChecked).toBe(false);
  });

  it("leaves a line outside both windows unmatched", () => {
    const lines = [line({ refNumber: null, date: "2026-08-06", amount: 250 })];
    const bills = [
      bill({
        id: "b1",
        supplierInvoiceNumber: null,
        totalOwed: 250,
        billDate: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ];

    const [match] = matchStatementLines(lines, bills);

    expect(match.tier).toBe("UNMATCHED");
    expect(match.billId).toBeNull();
    expect(match.candidates).toHaveLength(0);
  });

  it("never offers a VOID bill as a candidate, exact-ref or fuzzy", () => {
    const lines = [line({ refNumber: "INV100", amount: 250 })];
    const bills = [
      bill({ id: "b1", supplierInvoiceNumber: "INV100", totalOwed: 250, status: "VOID" }),
    ];

    const [match] = matchStatementLines(lines, bills);

    expect(match.tier).toBe("UNMATCHED");
    expect(match.billId).toBeNull();
    expect(match.candidates).toHaveLength(0);
  });

  it("never lets two lines claim the same bill", () => {
    const lines = [
      line({ refNumber: null, date: "2026-08-01", amount: 500 }),
      line({ refNumber: null, date: "2026-08-01", amount: 500 }),
    ];
    const bills = [
      bill({
        id: "b1",
        supplierInvoiceNumber: null,
        totalOwed: 500,
        billDate: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ];

    const matches = matchStatementLines(lines, bills);

    const claims = matches.filter((m) => m.billId === "b1");
    expect(claims).toHaveLength(1);
    // The losing line still sees the bill as a candidate for its picker —
    // it just doesn't get auto-picked.
    expect(matches.every((m) => m.tier === "FUZZY")).toBe(true);
    expect(matches.every((m) => m.candidates.some((c) => c.billId === "b1"))).toBe(true);
  });

  it("prefers the higher tier when two lines compete for one bill", () => {
    const lines = [
      line({ refNumber: null, date: "2026-08-01", amount: 500 }), // fuzzy only
      line({ refNumber: "INV500", date: "2026-08-01", amount: 500 }), // exact ref
    ];
    const bills = [
      bill({
        id: "b1",
        supplierInvoiceNumber: "INV500",
        totalOwed: 500,
        billDate: new Date("2026-08-01T00:00:00.000Z"),
      }),
    ];

    const matches = matchStatementLines(lines, bills);

    expect(matches[0].billId).toBeNull();
    expect(matches[0].tier).toBe("FUZZY");
    expect(matches[1].billId).toBe("b1");
    expect(matches[1].tier).toBe("EXACT_REF");
    expect(matches[1].preChecked).toBe(true);
  });

  it("demotes every pre-check when the lines don't reconcile to the stated closing balance", () => {
    const lines = [line({ refNumber: "INV100", amount: 250, kind: "INVOICE" })];
    const bills = [bill({ id: "b1", supplierInvoiceNumber: "INV100", totalOwed: 250 })];

    // opening 0 + invoice 250 should equal closing 250 — deliberately wrong.
    const [match] = matchStatementLines(lines, bills, { openingBalance: 0, closingBalance: 999 });

    expect(match.tier).toBe("EXACT_REF");
    expect(match.billId).toBe("b1");
    expect(match.preChecked).toBe(false);
  });

  it("keeps the pre-check when the lines DO reconcile to the stated closing balance", () => {
    const lines = [line({ refNumber: "INV100", amount: 250, kind: "INVOICE" })];
    const bills = [bill({ id: "b1", supplierInvoiceNumber: "INV100", totalOwed: 250 })];

    const [match] = matchStatementLines(lines, bills, { openingBalance: 0, closingBalance: 250 });

    expect(match.preChecked).toBe(true);
  });

  it("skips the sanity guard entirely when the statement carries no closing balance", () => {
    const lines = [line({ refNumber: "INV100", amount: 250 })];
    const bills = [bill({ id: "b1", supplierInvoiceNumber: "INV100", totalOwed: 250 })];

    const [match] = matchStatementLines(lines, bills, {
      openingBalance: null,
      closingBalance: null,
    });

    expect(match.preChecked).toBe(true);
  });

  it("normalizes ref numbers the same way on both sides (whitespace, case)", () => {
    const lines = [line({ refNumber: "inv 100", amount: 250 })];
    const bills = [bill({ id: "b1", supplierInvoiceNumber: "INV100", totalOwed: 250 })];

    const [match] = matchStatementLines(lines, bills);

    expect(match.billId).toBe("b1");
  });

  it("accounts for PAYMENT and CREDIT lines reducing the balance in the sanity guard", () => {
    const lines = [
      line({ refNumber: "INV100", amount: 250, kind: "INVOICE" }),
      line({ refNumber: null, date: "2026-08-05", amount: 100, kind: "PAYMENT" }),
    ];
    const bills = [bill({ id: "b1", supplierInvoiceNumber: "INV100", totalOwed: 250 })];

    // opening 0 + invoice 250 - payment 100 = 150, matching the stated closing balance.
    const matches = matchStatementLines(lines, bills, { openingBalance: 0, closingBalance: 150 });

    expect(matches[0].preChecked).toBe(true);
  });
});
