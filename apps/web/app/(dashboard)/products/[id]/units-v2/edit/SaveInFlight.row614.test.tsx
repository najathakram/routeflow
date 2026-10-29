import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { GRID, PRODUCT, SAVE_RESPONSE, SAVED_GRID } from "../window/k11-20a.fixtures";

// Row 614: a second Save while one is in flight is ignored (button, double click, Ctrl+S), so a successful
// save is never followed by a 409 against its own revision.

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

const stale = () =>
  Object.assign(new Error("409"), {
    isAxiosError: true,
    response: { status: 409, data: { code: "LADDER_REVISION_STALE" } },
  });

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={PRODUCT} />
    </QueryClientProvider>,
  );

const edit = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId(T.btnEdit));
  const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
  await user.clear(input);
  await user.type(input, "14.5");
};

let resolveFirst!: (v: unknown) => void;
beforeEach(() => {
  mockPost.mockReset();
  mockGrid = { data: GRID, isLoading: false, isError: false };
  let n = 0;
  mockPost.mockImplementation(() => {
    n += 1;
    if (n > 1) return Promise.reject(stale());
    return new Promise((res) => {
      resolveFirst = res;
    });
  });
});

const finish = async () => {
  await act(async () => {});
  mockGrid = { data: SAVED_GRID, isLoading: false, isError: false };
  await act(async () => {
    resolveFirst({ data: SAVE_RESPONSE });
  });
};

describe("row 614: Save ignores a second click in flight", () => {
  it("a double click sends one POST and ends on the Saved line, not a conflict", async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    const save = screen.getByTestId(T.ebSave);
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await finish();
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Reload prices" })).toBeNull();
    expect(await screen.findByText(/^Saved/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Undo/ })).toBeTruthy();
  });

  it("userEvent.dblClick sends one POST too", async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    await user.dblClick(screen.getByTestId(T.ebSave));
    await finish();
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/^Saved/)).toBeTruthy();
  });

  it("Ctrl+S during the click's flight sends no second POST", async () => {
    const user = userEvent.setup();
    mount();
    await edit(user);
    act(() => {
      fireEvent.click(screen.getByTestId(T.ebSave));
      fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    });
    await finish();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});
