import * as React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { GRID, PRODUCT, SAVE_RESPONSE, SAVED_GRID } from "../window/k11-20a.fixtures";

// K13 F12: after Save the focus moves to the saved line (without scrolling), so Undo is the next Tab stop.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { post: (...a: unknown[]) => mockPost(...a), patch: jest.fn() },
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

beforeEach(() => {
  mockPost.mockReset();
  mockPost.mockResolvedValue({ data: SAVE_RESPONSE });
  mockGrid = { data: GRID, isLoading: false, isError: false };
});
afterEach(() => jest.restoreAllMocks());

const save = async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={PRODUCT} />
    </QueryClientProvider>,
  );
  await user.click(screen.getByTestId(T.btnEdit));
  const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
  await user.clear(input);
  await user.type(input, "14.5");
  const focusSpy = jest.spyOn(HTMLElement.prototype, "focus");
  await user.click(screen.getByTestId(T.ebSave));
  await act(async () => {
    mockGrid = { data: SAVED_GRID, isLoading: false, isError: false };
  });
  await screen.findByText(/^Saved/);
  return { user, focusSpy };
};

describe("K13 F12: Save moves focus to the saved line", () => {
  it("focuses the saved line, and one Tab lands on Undo", async () => {
    const { user } = await save();
    const line = screen.getByTestId("units-v2-save-status");
    expect(document.activeElement).toBe(line);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Undo/ }));
  });

  it("does not scroll the page to do it", async () => {
    const { focusSpy } = await save();
    const line = screen.getByTestId("units-v2-save-status");
    const calls = focusSpy.mock.calls.filter((_c, i) => focusSpy.mock.contexts[i] === line);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([o]) => o?.preventScroll === true)).toBe(true);
  });
});
