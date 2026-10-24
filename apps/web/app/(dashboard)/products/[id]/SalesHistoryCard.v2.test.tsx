import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { SalesHistoryCard } from "./SalesHistoryCard";

jest.mock("@/lib/api/product-sales", () => ({
  useProductSales: () => ({
    data: {
      lines: [],
      summary: {
        count: 0,
        buyers: 0,
        totalQty: 0,
        totalRevenue: 0,
        minPrice: null,
        avgPrice: null,
        maxPrice: null,
      },
    },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));

function renderCard(hideCreateOrder?: boolean) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <SalesHistoryCard productId="p1" hideCreateOrder={hideCreateOrder} />
    </QueryClientProvider>,
  );
}

describe("SalesHistoryCard hideCreateOrder (T36)", () => {
  it("never-sold state has no create-an-order link when hidden", () => {
    renderCard(true);
    expect(screen.getByText("Never sold")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Create an order/ })).toBeNull();
  });

  it("never-sold state keeps the link when the prop is absent or false", () => {
    const a = renderCard();
    expect(screen.getByRole("link", { name: /Create an order/ })).toHaveAttribute(
      "href",
      "/orders?action=new",
    );
    a.unmount();
    renderCard(false);
    expect(screen.getByRole("link", { name: /Create an order/ })).toBeInTheDocument();
  });
});
