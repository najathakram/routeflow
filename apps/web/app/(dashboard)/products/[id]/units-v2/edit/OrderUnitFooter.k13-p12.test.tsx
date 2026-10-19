import * as React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { OrderUnitDraft } from "./OrderUnitDraft";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { GRID } from "../window/k11-20a.fixtures";

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

// K13 P12 (+P08): the pricing unit reads as the grid card's footer, on the card's content edge (the card pads p-4),
// and clear of whatever follows, instead of running into the "Customer view" heading.
describe("K13 P12: the pricing unit sits on the grid card's content edge", () => {
  it("is padded to the card's inner edge and spaced from what follows", () => {
    mockGrid = { data: GRID, isLoading: false, isError: false };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PriceDraftProvider productId="p1">
          <OrderUnitDraft />
        </PriceDraftProvider>
      </QueryClientProvider>,
    );
    const footer = screen.getByTestId("order-unit-footer");
    expect(footer.className).toMatch(/\bpx-4\b/);
    expect(footer.className).toMatch(/\bmb-4\b/);
  });
});
