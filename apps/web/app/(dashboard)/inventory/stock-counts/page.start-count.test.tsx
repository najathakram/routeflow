import * as React from "react";
import { render, screen } from "@testing-library/react";
import StockCountsHistoryPage from "./page";

/** B1480: the Stock counts page offers "Start a count" (to the Inventory Stock count tab), also when empty. */
jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@/lib/hooks/useUrlPage", () => ({
  useUrlPage: () => [1, jest.fn()],
  useClampPage: jest.fn(),
}));
let mockData: { data: unknown[]; meta?: unknown } = { data: [] };
jest.mock("@/lib/api/stock-count", () => ({
  useStockCountSessions: () => ({ data: mockData, isLoading: false }),
}));

describe("Stock counts page start button (B1480)", () => {
  it("empty history: a button in the header and a link in the empty state, both to the count tab", () => {
    mockData = { data: [] };
    render(<StockCountsHistoryPage />);
    const starts = screen.getAllByRole("link", { name: "Start a count" });
    expect(starts).toHaveLength(2);
    starts.forEach((a) => expect(a).toHaveAttribute("href", "/inventory?tab=count"));
    expect(screen.getByText("No stock counts yet.")).toBeInTheDocument();
  });

  it("with history: the header button is still there", () => {
    mockData = {
      data: [
        {
          id: "s1",
          status: "COMMITTED",
          startedAt: "2026-11-26T00:00:00Z",
          name: "UX shelf count",
          startedBy: { username: "dana" },
          _count: { lines: 2 },
          netVarianceMoney: 0,
        },
      ],
    };
    render(<StockCountsHistoryPage />);
    expect(screen.getAllByRole("link", { name: "Start a count" })).toHaveLength(1);
  });
});
