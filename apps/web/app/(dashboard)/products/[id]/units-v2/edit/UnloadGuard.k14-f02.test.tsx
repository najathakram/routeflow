import * as React from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { GRID, PRODUCT, SAVE_RESPONSE, SAVED_GRID } from "../window/k11-20a.fixtures";

// K14 F02: a dirty v2 edit grid asks the browser to confirm a reload or close; a clean one does not.

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

const handlers = () =>
  (window.addEventListener as jest.Mock).mock.calls.filter((c) => c[0] === "beforeunload");

const open = async () => {
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={PRODUCT} />
    </QueryClientProvider>,
  );
  await user.click(screen.getByTestId(T.btnEdit));
  return user;
};

describe("K14 F02: unsaved price edits survive an accidental reload", () => {
  beforeEach(() => jest.spyOn(window, "addEventListener"));

  it("registers beforeunload (preventDefault) once a price is changed", async () => {
    const user = await open();
    expect(handlers()).toHaveLength(0);
    const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
    await user.clear(input);
    await user.type(input, "14.5");
    expect(handlers().length).toBeGreaterThan(0);
    const evt = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("a clean edit grid registers nothing", async () => {
    await open();
    expect(handlers()).toHaveLength(0);
  });
});
