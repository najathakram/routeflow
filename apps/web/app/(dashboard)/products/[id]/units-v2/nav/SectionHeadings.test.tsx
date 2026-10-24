import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { SalesHistoryCard } from "../../SalesHistoryCard";
import { CustomerPriceView, resetCustomerViewMemory } from "../customer/CustomerPriceView";
import { ProductJumpLinks } from "./ProductJumpLinks";

// K10d (V19): the sections the product page owns carry the heading ids the jump strip targets.
jest.mock("@/lib/api/product-sales", () => ({
  useProductSales: () => ({
    data: {
      lines: [],
      summary: { count: 0, buyers: 0, totalQty: 0, totalRevenue: 0 },
    },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api/useCustomerUnitPrices", () => ({
  useCustomerUnitPrices: () => ({ data: undefined, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api/customers", () => ({ useCustomers: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));

class FakeIO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

beforeEach(() => {
  resetCustomerViewMemory();
  (window as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
  Element.prototype.scrollIntoView = jest.fn();
});

function Page() {
  return (
    <QueryClientProvider client={createTestQueryClient()}>
      <ProductJumpLinks />
      <h1 id="h-product">Cola</h1>
      <h2 id="units-v2-grid-title">Prices by unit</h2>
      <CustomerPriceView productId="p1" />
      <SalesHistoryCard productId="p1" />
    </QueryClientProvider>
  );
}

describe("section heading ids", () => {
  it("the Sales card heading is #h-sales", () => {
    render(<Page />);
    const h = document.getElementById("h-sales");
    expect(h).not.toBeNull();
    expect(h).toHaveTextContent("Sales");
    expect(document.querySelectorAll("#h-sales")).toHaveLength(1);
  });

  it("the Customer view heading is #h-cust and still labels its section", () => {
    render(<Page />);
    const h = document.getElementById("h-cust");
    expect(h).not.toBeNull();
    expect(h?.tagName).toBe("H2");
    expect(screen.getByTestId("units-v2-sec-customers")).toHaveAttribute(
      "aria-labelledby",
      "h-cust",
    );
    expect(document.querySelectorAll("#h-cust")).toHaveLength(1);
  });

  it("the jump strip links Product, Units and prices, Customer view and Sales", async () => {
    render(<Page />);
    await waitFor(() => expect(screen.getByTestId("units-v2-jump-h-sales")).toBeInTheDocument());
    for (const id of ["h-product", "h-units", "h-cust", "h-sales"]) {
      expect(screen.getByTestId(`units-v2-jump-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("units-v2-jump-h-sales")).toHaveAttribute("href", "#h-sales");
    expect(screen.getByTestId("units-v2-jump-h-cust")).toHaveAttribute("href", "#h-cust");
  });
});
