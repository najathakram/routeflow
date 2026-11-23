import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import FinancesPage from "./page";

/** SA-1211 A1.3: "Avg order value" is order-based, so it is hidden when the buyer has no orders. */

jest.mock("next/navigation", () => ({ useParams: () => ({ seller: "acme" }) }));
jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));
// The chart needs a layout engine jsdom does not have; the page's text is what matters here.
jest.mock("recharts", () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    BarChart: Stub,
    Bar: Stub,
    XAxis: Stub,
    YAxis: Stub,
    CartesianGrid: Stub,
    Tooltip: Stub,
    ResponsiveContainer: Stub,
  };
});

let summary: { totalOrders: number; totalSpend: number; avgOrderValue: number };
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerAnalytics: () => ({
    isLoading: false,
    isError: false,
    data: {
      monthlySpend: [],
      summary: { ...summary, unpaidInvoiceCount: 0, unpaidInvoiceTotal: 0 },
      invoiceBreakdown: { paid: 1, unpaid: 0, overdue: 0 },
      recentPayments: [],
    },
  }),
  useBuyerStatement: () => ({ data: undefined }),
}));

describe("buyer portal Finances: Total spend and Avg order value", () => {
  it("an invoice-only buyer sees the spend and no Avg order value", () => {
    summary = { totalOrders: 0, totalSpend: 150, avgOrderValue: 0 };
    renderWithProviders(<FinancesPage />);
    expect(screen.getByText("$150.00")).toBeInTheDocument();
    expect(screen.queryByText(/Avg/)).not.toBeInTheDocument();
  });

  it("an ordering buyer still sees the average", () => {
    summary = { totalOrders: 2, totalSpend: 400, avgOrderValue: 75 };
    renderWithProviders(<FinancesPage />);
    expect(screen.getByText("Avg $75.00 / order")).toBeInTheDocument();
  });
});
