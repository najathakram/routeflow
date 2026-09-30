import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { SalesHistoryCard } from "./SalesHistoryCard";

/**
 * Money-display component 2/2. SalesHistoryCard's summary chips render
 * `fmt()` (lib/formatting.ts — the same `Intl.NumberFormat("en-US", {style:
 * "currency", currency:"USD"})` shape as lib/format.ts's `formatMoney`) over
 * raw numbers from the product-sales query. minPrice/avgPrice/maxPrice are
 * chosen purely to exercise the three required format cases (0, 1234.5,
 * -12.34) — a negative "max price" is not realistic data, only a formatting
 * probe.
 */
jest.mock("@/lib/api/product-sales", () => ({
  useProductSales: () => ({
    data: {
      lines: [
        {
          date: "2026-01-05",
          invoiceId: "inv-1",
          invoiceNumber: "INV-1",
          orderId: null,
          orderNumber: null,
          customerId: "c1",
          customerName: "Acme Foods",
          qty: 10,
          boxes: null,
          pieces: null,
          unitsPerBox: null,
          // Distinct from the three summary-chip values below so each format
          // assertion below matches exactly one element on the page.
          unitPrice: 50,
          lineTotal: 50,
          originalPrice: null,
          overridden: false,
        },
      ],
      summary: {
        count: 1,
        buyers: 1,
        totalQty: 10,
        totalRevenue: 1234.5,
        minPrice: 0,
        avgPrice: 99.99,
        maxPrice: -12.34,
      },
    },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));

function renderCard() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <SalesHistoryCard productId="p1" />
    </QueryClientProvider>,
  );
}

describe("SalesHistoryCard — money display", () => {
  it("formats 1234.5 as $1,234.50 (Total revenue chip)", () => {
    renderCard();
    expect(screen.getByText("$1,234.50")).toBeInTheDocument();
  });

  it("formats 0 as $0.00 (Min price chip)", () => {
    renderCard();
    expect(screen.getByText("$0.00")).toBeInTheDocument();
  });

  it("formats -12.34 as -$12.34 (Max price chip)", () => {
    renderCard();
    expect(screen.getByText("-$12.34")).toBeInTheDocument();
  });
});
