import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { PLAN_TESTIDS } from "./plan-testids";
import { GRID, PRODUCT } from "../window/k11-20a.fixtures";

// W-1170 F10 / P7: people who want to type an exact price clicked "Change prices" first (it only moves by % or
// amount). Edit is the primary button, Change prices the secondary, and the panel links to Edit.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));
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

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={PRODUCT} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockGrid = { data: GRID, isLoading: false, isError: false };
});

describe("W-1170 F10: Edit leads, Change prices follows", () => {
  it("Edit is the filled primary button and Change prices the outline secondary", () => {
    mount();
    expect(screen.getByTestId(T.btnEdit).className).toContain("bg-brand-600");
    expect(screen.getByTestId(T.btnChange).className).not.toContain("bg-brand-600");
  });

  it("the Change prices panel offers 'Type an exact price instead', which closes it and opens Edit", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnChange));
    const panel = screen.getByTestId(PLAN_TESTIDS.changePanel);
    await user.click(within(panel).getByRole("button", { name: "Type an exact price instead" }));
    expect(screen.queryByTestId(PLAN_TESTIDS.changePanel)).toBeNull();
    expect(screen.getByTestId(T.editbar)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getAllByTestId(/^units-v2-input-/)[0]);
  });
});
