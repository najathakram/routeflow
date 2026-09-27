import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { OrderReturnsPanel } from "./OrderReturnsPanel";
import type { Return } from "@/lib/api/returns";

// #2406 — renders the SERVER's own figures from GET /returns?orderId=<id>, never a quote's.
let mockReturns: Return[] = [];
jest.mock("@/lib/api/returns", () => ({
  useReturns: () => ({
    data: {
      data: mockReturns,
      meta: { total: mockReturns.length, page: 1, limit: 50, totalPages: 1 },
    },
  }),
}));

beforeEach(() => {
  mockReturns = [];
});

describe("OrderReturnsPanel (#2406)", () => {
  it("renders nothing when this order has no returns", () => {
    const { container } = renderWithProviders(<OrderReturnsPanel orderId="o1" />);
    expect(screen.queryByText(/returns on this order/i)).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="order-return-row"]')).toBeNull();
  });

  it("renders the server's return number, status and refund amount — not a quote figure", () => {
    mockReturns = [
      {
        id: "ret-1",
        returnNumber: "R-1",
        customerId: "c1",
        orderId: "o1",
        status: "REFUNDED",
        reason: "DAMAGED",
        items: [],
        createdAt: "2026-09-01",
        updatedAt: "2026-09-01",
        refundAmount: "22.5000",
        creditNoteId: "cn-1",
      } as unknown as Return,
    ];
    renderWithProviders(<OrderReturnsPanel orderId="o1" />);

    expect(screen.getByText(/returns on this order/i)).toBeInTheDocument();
    expect(screen.getByText("#R-1")).toBeInTheDocument();
    expect(screen.getByText("$22.50")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /credit note/i })).toHaveAttribute(
      "href",
      "/credit-notes/cn-1",
    );
  });

  it("hides the credit-note link and amount when absent, without crashing", () => {
    mockReturns = [
      {
        id: "ret-2",
        returnNumber: "R-2",
        customerId: "c1",
        orderId: "o1",
        status: "RECEIVED",
        reason: "EXCESS_ORDER",
        items: [],
        createdAt: "2026-09-02",
        updatedAt: "2026-09-02",
      } as unknown as Return,
    ];
    renderWithProviders(<OrderReturnsPanel orderId="o1" />);
    expect(screen.getByText("#R-2")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /credit note/i })).not.toBeInTheDocument();
  });
});
