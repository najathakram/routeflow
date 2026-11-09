import * as React from "react";
import { render, screen } from "@testing-library/react";
import FinancesPage from "./page";

/**
 * B242: the "Showing N of ..." note on Active credits means THIS list is cut short. The ledger's own
 * whole-statement flag (`transactionsTruncated`) must not raise it while every credit is rendered.
 * Fixtures are placeholders.
 */
let statement: Record<string, unknown>;

jest.mock("next/navigation", () => ({ useParams: () => ({ seller: "acme" }) }));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    activeSeller: { tenant: { name: "Acme Wholesale" }, customer: { businessName: "Sample Co" } },
  }),
}));
jest.mock("recharts", () => {
  const Null = () => null;
  return {
    BarChart: Null,
    Bar: Null,
    XAxis: Null,
    YAxis: Null,
    CartesianGrid: Null,
    Tooltip: Null,
    ResponsiveContainer: Null,
  };
});
jest.mock("@/lib/api/buyer", () => ({
  useBuyerAnalytics: () => ({
    isLoading: false,
    isError: false,
    data: {
      summary: {
        totalSpend: 0,
        totalOrders: 0,
        avgOrderValue: 0,
        unpaidInvoiceTotal: 0,
        unpaidInvoiceCount: 0,
      },
      monthlySpend: [],
      invoiceBreakdown: { paid: 0, overdue: 0 },
      recentPayments: [],
    },
  }),
  useBuyerStatement: () => ({ data: statement }),
}));

const credits = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i}`,
    type: "CREDIT_NOTE",
    description: `Credit ${i}`,
    date: "2026-10-01T00:00:00Z",
    runningBalance: 10,
    expiresAt: null,
  }));

const NOTE = /active credits; the wallet total includes everything/i;

describe("buyer finances — Active credits truncation note", () => {
  it("ledger flag set but every credit is rendered: no note", () => {
    statement = { availableCredit: 30, transactionsTruncated: true, transactions: credits(3) };
    render(<FinancesPage />);
    expect(screen.getByText("Credit 2")).toBeInTheDocument();
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument();
  });

  it("more credits than the 6-row budget: the note shows", () => {
    statement = { availableCredit: 80, transactionsTruncated: false, transactions: credits(8) };
    render(<FinancesPage />);
    expect(screen.getByText(NOTE)).toBeInTheDocument();
  });
});
