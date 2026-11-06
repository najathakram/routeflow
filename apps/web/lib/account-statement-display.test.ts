import type { AccountStatement, AccountStatementInvoice } from "@routeflow/types";
import {
  daysLateLabel,
  mayOpenStatement,
  showingLabel,
  statementShape,
} from "./account-statement-display";

const row = (n: number, over: Partial<AccountStatementInvoice> = {}) => ({
  id: `i${n}`,
  invoiceNumber: `INV-${n}`,
  issueDate: "2026-10-01",
  dueDate: "2026-10-15",
  total: 100,
  paid: 0,
  credit: 0,
  unpaid: 100,
  daysLate: 0,
  ...over,
});

const stmt = (over: Partial<AccountStatement> = {}): AccountStatement => ({
  asOf: "2026-10-31T12:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Wholesale" },
  openBalance: 0,
  overdue: 0,
  creditAvailable: 0,
  afterCredit: 0,
  waitingToClear: 0,
  openInvoices: [],
  recentPayments: [],
  recentPaymentsTruncated: false,
  credits: [],
  ...over,
});

describe("statement words (SA-1078)", () => {
  it("days late reads 1 day / n days", () => {
    expect(daysLateLabel(1)).toBe("1 day late");
    expect(daysLateLabel(12)).toBe("12 days late");
  });
  it("the cut note names how many are shown and that the PDF has them all", () => {
    expect(showingLabel(200, 250)).toBe("Showing 200 of 250. The PDF has them all.");
  });
});

describe("statementShape", () => {
  it("U16: 250 open invoices -> the oldest 200 on screen, cut flagged with the full count", () => {
    const s = statementShape(stmt({ openInvoices: Array.from({ length: 250 }, (_, i) => row(i)) }));
    expect(s.rows).toHaveLength(200);
    expect(s.rows[0].id).toBe("i0");
    expect(s.cut).toBe(true);
    expect(s.total).toBe(250);
  });
  it("200 or fewer is never cut", () => {
    expect(statementShape(stmt({ openInvoices: [row(1)] })).cut).toBe(false);
  });
  it("U14: the Credit column shows only when some row carries a credit", () => {
    expect(statementShape(stmt({ openInvoices: [row(1), row(2)] })).showCreditColumn).toBe(false);
    expect(
      statementShape(stmt({ openInvoices: [row(1), row(2, { credit: 5 })] })).showCreditColumn,
    ).toBe(true);
  });
  it("U13: the credit lines show only above 0", () => {
    expect(statementShape(stmt()).showCreditLines).toBe(false);
    expect(statementShape(stmt({ creditAvailable: 10, afterCredit: 40 })).showCreditLines).toBe(
      true,
    );
  });
  it("waiting to clear shows only above 0", () => {
    expect(statementShape(stmt()).showWaiting).toBe(false);
    expect(statementShape(stmt({ waitingToClear: 3 })).showWaiting).toBe(true);
  });
  it("U12: no open invoices is empty", () => {
    expect(statementShape(stmt()).empty).toBe(true);
  });
});

describe("mayOpenStatement (U7)", () => {
  const known = { permissionsKnown: true };
  it("a tenant admin may", () => {
    expect(mayOpenStatement("TENANT_ADMIN", [], known)).toBe(true);
  });
  it("an operator with FINANCE or CUSTOMERS may", () => {
    expect(mayOpenStatement("OPERATOR", ["CUSTOMERS"], known)).toBe(true);
    expect(mayOpenStatement("OPERATOR", ["FINANCE"], known)).toBe(true);
    expect(mayOpenStatement("OPERATOR", [], known)).toBe(true);
  });
  it("an operator with neither (REPORTS only) gets the plain figure", () => {
    expect(mayOpenStatement("OPERATOR", ["FINANCE", "CUSTOMERS"], known)).toBe(false);
  });
  it("an operator whose permissions are not known yet gets the plain figure, never a 403", () => {
    expect(mayOpenStatement("OPERATOR", [], { permissionsKnown: false })).toBe(false);
  });
  it("drivers, buyers and an unknown role never get it", () => {
    expect(mayOpenStatement("DRIVER", [], known)).toBe(false);
    expect(mayOpenStatement("CUSTOMER", [], known)).toBe(false);
    expect(mayOpenStatement(undefined, [], known)).toBe(false);
  });
});
