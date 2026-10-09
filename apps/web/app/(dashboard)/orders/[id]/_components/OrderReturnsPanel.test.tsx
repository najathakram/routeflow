import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { OrderReturnsPanel } from "./OrderReturnsPanel";
import type { Return } from "@/lib/api/returns";

// #2406 — renders the SERVER's own figures from GET /returns?orderId=<id>, never a quote's.
let mockReturns: Return[] = [];
const useReturnsMock = jest.fn();
jest.mock("@/lib/api/returns", () => ({
  useReturns: (...args: unknown[]) => useReturnsMock(...args),
}));

beforeEach(() => {
  mockReturns = [];
  useReturnsMock.mockReset();
  useReturnsMock.mockImplementation(() => ({
    data: {
      data: mockReturns,
      meta: { total: mockReturns.length, page: 1, limit: 50, totalPages: 1 },
    },
  }));
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

  it("requests kind ALL — so a captured INLINE return is not silently dropped", () => {
    renderWithProviders(<OrderReturnsPanel orderId="o1" />);
    expect(useReturnsMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o1", kind: "ALL", limit: 50 }),
    );
  });

  it("renders an INLINE row's refundAmount", () => {
    mockReturns = [
      {
        id: "ret-inline-1",
        returnNumber: "R-3",
        kind: "INLINE",
        customerId: "c1",
        orderId: "o1",
        status: "REFUNDED",
        reason: "DAMAGED",
        items: [],
        createdAt: "2026-09-03",
        updatedAt: "2026-09-03",
        refundAmount: "14.9700",
        refundEstimate: null,
        refundEstimateReason: "INLINE",
      } as unknown as Return,
    ];
    renderWithProviders(<OrderReturnsPanel orderId="o1" />);
    expect(screen.getByText("#R-3")).toBeInTheDocument();
    expect(screen.getByText("$14.97")).toBeInTheDocument();
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

  const base = {
    customerId: "c1",
    orderId: "o1",
    reason: "DAMAGED",
    items: [],
    createdAt: "2026-09-03",
    updatedAt: "2026-09-03",
  };
  it("W21b: a store-credit inline return reads 'Store credit', not 'Refunded'", () => {
    mockReturns = [
      {
        ...base,
        id: "r1",
        returnNumber: "R-5",
        kind: "INLINE",
        status: "REFUNDED",
        refundMethod: "CREDIT_NOTE",
        creditNoteId: "cn-5",
        refundAmount: "9.0000",
      } as unknown as Return,
    ];
    renderWithProviders(<OrderReturnsPanel orderId="o1" />);
    const row = screen.getByTestId("order-return-row");
    expect(row).toHaveTextContent("Store credit");
    expect(row).not.toHaveTextContent(/refunded/i);
  });
  it("W21b: a store-credit return with only a credit note id (no method) is store credit", () => {
    mockReturns = [
      {
        ...base,
        id: "r2",
        returnNumber: "R-6",
        status: "REFUNDED",
        creditNoteId: "cn-6",
      } as unknown as Return,
    ];
    renderWithProviders(<OrderReturnsPanel orderId="o1" />);
    expect(screen.getByTestId("order-return-row")).toHaveTextContent("Store credit");
  });
  it("W21b: a cash/card/check refund (EXTERNAL_REFUND) keeps 'Refunded'", () => {
    mockReturns = [
      {
        ...base,
        id: "r3",
        returnNumber: "R-7",
        kind: "INLINE",
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: "9.0000",
      } as unknown as Return,
    ];
    renderWithProviders(<OrderReturnsPanel orderId="o1" />);
    const row = screen.getByTestId("order-return-row");
    expect(row).toHaveTextContent("Refunded");
    expect(row).not.toHaveTextContent("Store credit");
  });
});
