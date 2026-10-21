import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { GRID, PRODUCT } from "../window/k11-20a.fixtures";

// Row 614 sibling: Apply only stages, but a second click in the same tick must not stage the change twice.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

it("a double click on Apply stages 5% once, not twice", async () => {
  mockGrid = { data: GRID, isLoading: false, isError: false };
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={PRODUCT} />
    </QueryClientProvider>,
  );
  await user.click(screen.getByTestId(T.btnChange));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "5" } });
  const apply = screen.getByRole("button", { name: "Apply" });
  act(() => {
    fireEvent.click(apply);
    fireEvent.click(apply);
  });
  const box = within(screen.getByTestId(T.row("piece"))).getByTestId(T.input("piece", 1));
  // the anchor Piece Retail 0.92 + 5% (staged against the served grid, never compounded)
  expect((box as HTMLInputElement).value).toBe("0.97");
});
