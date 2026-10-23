import * as React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { UNITS_V2_CONFIRM_TESTIDS as C } from "../confirm/confirm-testids";
import { GRID, PRODUCT, SAVE_RESPONSE, SAVED_GRID } from "../window/k11-20a.fixtures";

// SA-845 R9 (W-662, B1247): a 200 the server marks `replayed` (this actor's own save, re-sent after a lost reply) is an
// ordinary success: the Saved line shows, the stale notice does not, and Undo names the original write's auditId.
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

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductPricingV2 product={PRODUCT} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockPost.mockReset();
  mockGrid = { data: GRID, isLoading: false, isError: false };
});

describe("SA-845 R9: a replayed save is an ordinary success", () => {
  it("shows the Saved line and an Undo that posts the original auditId; no stale notice", async () => {
    mockPost.mockImplementation((url: string) => {
      if (url.endsWith("/prices/undo"))
        return Promise.resolve({
          data: { ...SAVE_RESPONSE, auditId: "a2", revision: 9, grid: GRID },
        });
      mockGrid = { data: SAVED_GRID, isLoading: false, isError: false };
      return Promise.resolve({ data: { ...SAVE_RESPONSE, replayed: true } });
    });
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByTestId(T.btnEdit));
    const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
    await user.clear(input);
    await user.type(input, "14.5");
    await act(async () => {
      fireEvent.click(screen.getByTestId(T.ebSave));
    });
    expect(await screen.findByText(/^Saved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload prices" })).toBeNull();
    expect(screen.queryByText(/changed since you opened/i)).toBeNull();
    await user.click(screen.getByTestId(C.saveUndo));
    await waitFor(() =>
      expect(mockPost.mock.calls.some(([url]) => String(url).endsWith("/prices/undo"))).toBe(true),
    );
    const undoCall = mockPost.mock.calls.find(([url]) => String(url).endsWith("/prices/undo"));
    expect(undoCall?.[1]).toMatchObject({ auditId: "a1" });
  });
});
