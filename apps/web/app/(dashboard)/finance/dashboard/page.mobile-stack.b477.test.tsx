import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import FinanceDashboardPage from "./page";

/**
 * B477. At 390px the "Sales and Expenses" card (col-span-2) and "Top Expenses" card sat side by
 * side in a bare grid-cols-3 and the legend row spilled over the neighbour. jsdom has no layout,
 * so the fix is pinned at the class level: one column below md, the 3-column split from md up,
 * and a header and legend that wrap instead of overflowing. The measured result lives in the
 * phone-width live check.
 */
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), prefetch: jest.fn() }),
  usePathname: () => "/finance/dashboard",
}));
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/api/finance", () => ({
  useFinanceDashboard: () => ({
    isLoading: false,
    refetch: jest.fn(),
    data: {
      arAging: { total: 0, current: 0, days1_15: 0, days16_30: 0, days31_45: 0, days45plus: 0 },
      monthlySales: {
        totalSales: 1000,
        totalReceipts: 800,
        totalExpenses: 300,
        data: [{ month: "Jan", sales: 1000, receipts: 800, expenses: 300 }],
      },
      topExpenses: [{ name: "Fuel", amount: 300 }],
      summaryTable: {},
    },
  }),
}));

function cards() {
  renderWithProviders(<FinanceDashboardPage />);
  const sales = screen
    .getByRole("heading", { name: "Sales and Expenses" })
    .closest(".rounded-card");
  const top = screen.getByRole("heading", { name: "Top Expenses" }).closest(".rounded-card");
  if (!sales || !top) throw new Error("chart cards not found");
  return { sales, top, grid: sales.parentElement as HTMLElement };
}

describe("finance dashboard chart cards (B477)", () => {
  it("the row containing both cards is one column below md and three columns from md", () => {
    const { sales, top, grid } = cards();
    expect(top.parentElement).toBe(grid);
    expect(sales).not.toBe(top);
    expect(grid.classList.contains("grid")).toBe(true);
    expect(grid.classList.contains("grid-cols-1")).toBe(true);
    expect(grid.classList.contains("md:grid-cols-3")).toBe(true);
    expect(grid.classList.contains("grid-cols-3")).toBe(false);
  });

  it("the Sales card spans two columns only from md", () => {
    const { sales } = cards();
    expect(sales.classList.contains("md:col-span-2")).toBe(true);
    expect(sales.classList.contains("col-span-2")).toBe(false);
  });

  it("the Sales header and legend wrap instead of overflowing", () => {
    const { sales } = cards();
    const header = screen
      .getByRole("heading", { name: "Sales and Expenses" })
      .closest(".border-b") as HTMLElement;
    expect(sales.contains(header)).toBe(true);
    expect(header.classList.contains("flex-wrap")).toBe(true);
    const legend = screen.getByText("Total sales").closest(".text-xs") as HTMLElement;
    expect(legend.classList.contains("flex-wrap")).toBe(true);
  });
});
