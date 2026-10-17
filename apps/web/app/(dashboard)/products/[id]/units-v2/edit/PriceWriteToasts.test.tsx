import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { UNITS_V2_CONFIRM_TESTIDS as C } from "../confirm/confirm-testids";

// M4: the REAL price write hooks behind the real page, with the REAL app-wide error handler installed. A failed
// Save or Undo is said once, by the edit bar / status line; the global toast must stay quiet.

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

const cells = (v: number[], src: Array<"auto" | "set"> = []) =>
  v.map((value, i) => ({
    tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
    value,
    source: src[i] ?? "auto",
  }));
const grid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "piece",
  revision: 7,
  priceState: "ps-1",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "case",
      label: "Case",
      factor: 960,
      kind: "pack",
      editable: true,
      code: null,
      cells: cells([0, 13.91, 12.5, 11, 10], ["set", "set", "auto", "auto", "auto"]),
    },
    {
      ref: "piece",
      label: "Piece",
      factor: 1,
      kind: "base",
      editable: true,
      code: null,
      cells: cells([0.92, 0.9, 0.88, 0.85, 0.8], ["set"]),
    },
  ],
};
const saved: ProductPriceGridDto = { ...grid, revision: 8, priceState: "ps-2" };
const product = { id: "p1", unit: "Piece", unitsPerBox: 24, pricePerUnit: "0.92" };

const mountWith = (globalToast: jest.Mock) =>
  render(
    <QueryClientProvider client={queryClientWithGlobalErrorToast(globalToast)}>
      <ProductPricingV2 product={product} />
    </QueryClientProvider>,
  );
const editAndSave = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId(T.btnEdit));
  const input = within(screen.getByTestId(T.row("case"))).getByTestId(T.input("case", 2));
  await user.clear(input);
  await user.type(input, "14.5");
  await user.click(screen.getByTestId(T.ebSave));
};

beforeEach(() => {
  mockPost.mockReset();
  mockGrid = { data: grid, isLoading: false, isError: false };
});

describe("M4: price writes say their failure once, locally", () => {
  it("a stale save shows the stale notice and no global toast", async () => {
    mockPost.mockRejectedValue(refusal(409, { code: "LADDER_REVISION_STALE" }));
    const globalToast = jest.fn();
    const user = userEvent.setup();
    mountWith(globalToast);
    await editAndSave(user);
    expect(await screen.findByRole("button", { name: "Reload prices" })).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(globalToast).not.toHaveBeenCalled();
  });

  it("a failed undo shows the status line's own copy and no global toast", async () => {
    mockPost.mockImplementation((path: string) => {
      if (path.endsWith("/prices/undo")) return Promise.reject(refusal(500, { message: "boom" }));
      mockGrid = { data: saved, isLoading: false, isError: false };
      return Promise.resolve({
        data: {
          auditId: "a1",
          revision: 8,
          undo: { patches: [{ ref: "case", tier: 2, to: 13.91 }], customerMoves: [] },
          grid: saved,
        },
      });
    });
    const globalToast = jest.fn();
    const user = userEvent.setup();
    mountWith(globalToast);
    await editAndSave(user);
    expect(await screen.findByText("Saved")).toBeTruthy();
    await user.click(screen.getByTestId(C.saveUndo));
    expect(await screen.findByText("Couldn't undo. Try again.")).toBeTruthy();
    expect(mockPost.mock.calls.some(([path]) => String(path).endsWith("/prices/undo"))).toBe(true);
    expect(globalToast).not.toHaveBeenCalled();
  });
});
