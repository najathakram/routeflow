import * as React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { GRID, PRODUCT, SAVE_RESPONSE, SAVED_GRID } from "../window/k11-20a.fixtures";

// K13 F05/F11: after an inline Save the editor collapses (order unit, the reserved slot and the bar go) and the page
// ended up away from the grid. The grid stays in view: if the commit left its top outside the viewport, it is
// scrolled back to the top; a grid still in view is left alone.

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

const scrolled: Element[] = [];
let gridTop = 0;
beforeEach(() => {
  scrolled.length = 0;
  gridTop = 0;
  mockPost.mockReset();
  mockPost.mockResolvedValue({ data: SAVE_RESPONSE });
  mockGrid = { data: GRID, isLoading: false, isError: false };
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this);
  };
  const real = Element.prototype.getBoundingClientRect;
  jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    if (this.getAttribute("data-testid") === "units-v2-grid-root")
      return {
        top: gridTop,
        bottom: gridTop + 300,
        left: 0,
        right: 800,
        width: 800,
        height: 300,
      } as DOMRect;
    return real.call(this);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  // @ts-expect-error jsdom has none
  delete Element.prototype.scrollIntoView;
});

const saveOnce = async () => {
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
  scrolled.length = 0;
  gridTop = -600; // the collapse left the grid above the viewport
  await user.click(screen.getByTestId(T.ebSave));
  await act(async () => {
    mockGrid = { data: SAVED_GRID, isLoading: false, isError: false };
  });
  await screen.findByText(/^Saved/);
};

describe("K13 F05/F11: Save keeps the grid in view", () => {
  it("scrolls the grid back when the collapse left its top above the viewport", async () => {
    await saveOnce();
    expect(scrolled.some((el) => el.getAttribute("data-testid") === "units-v2-grid-root")).toBe(
      true,
    );
  });

  it("leaves the page alone when the grid is still in view", async () => {
    gridTop = 0;
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
    scrolled.length = 0;
    await user.click(screen.getByTestId(T.ebSave));
    await screen.findByText(/^Saved/);
    expect(scrolled.some((el) => el.getAttribute("data-testid") === "units-v2-grid-root")).toBe(
      false,
    );
  });
});
