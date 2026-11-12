import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { EditablePricesGrid } from "./EditablePricesGrid";
import { PriceDraftProvider } from "./PriceDraftProvider";
import { usePriceDraft, type PriceDraft } from "./usePriceDraft";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";

// W-1170 F6 (completeness): "Use family prices" and every draft action that opens edit mode (beginEditing) are
// refused for an operator without the PRICING group, not only the grid's own Edit and price cells.

let mockGrid: { data?: ProductPriceGridDto; isLoading: boolean; isError: boolean };
let authUser: { id: string; role: string } | null = null;
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn(), patch: jest.fn() },
}));
jest.mock("@/lib/auth-context", () => ({
  useOptionalAuth: () => (authUser ? { user: authUser } : null),
}));
jest.mock("@/lib/api/usePriceGrid", () => ({
  ...jest.requireActual("@/lib/api/usePriceGrid"),
  usePriceGrid: () => mockGrid,
  fetchPriceGrid: () => Promise.resolve(mockGrid.data),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: {} }) }));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

const ALL = ["SELLING", "PRICING", "INVENTORY"];
const family = [
  { value: 24, follows: false },
  { value: 22, follows: false },
  { value: null, follows: false },
  { value: null, follows: false },
  { value: null, follows: false },
];
const variantGrid: ProductPriceGridDto = {
  productId: "p1",
  anchor: "pack",
  revision: 7,
  priceState: "ps-1",
  tierAnchors: {},
  tierRules: {},
  rows: [
    {
      ref: "pack",
      label: "Case",
      factor: 12,
      kind: "pack",
      editable: true,
      code: null,
      cells: [30, 28, 26, 25, 24].map((value, i) => ({
        tier: (i + 1) as 1 | 2 | 3 | 4 | 5,
        value,
        source: (i < 2 ? "set" : "auto") as "set" | "auto",
        family: family[i],
      })),
    },
  ],
};
const product = { id: "p1", unit: "Case", unitsPerBox: 12, pricePerUnit: "30" };

let draft: PriceDraft;
function Probe() {
  draft = usePriceDraft();
  return null;
}
const mount = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <PriceDraftProvider productId="p1">
        <Probe />
        <EditablePricesGrid product={product} />
      </PriceDraftProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockGet.mockReset();
  mockGrid = { data: variantGrid, isLoading: false, isError: false };
});

describe("W-1170 F6: Use family prices follows the PRICING group", () => {
  it("denied: no Use family prices button, and the draft action does not enter edit mode", async () => {
    authUser = { id: "u1", role: "OPERATOR" };
    mockGet.mockResolvedValue({
      data: { groups: ALL.filter((g) => g !== "PRICING"), version: 1, mode: "live" },
    });
    mount();
    expect(await screen.findByText("Ask an admin for pricing access.")).toBeTruthy();
    expect(screen.queryByTestId(T.btnUseFamilyPrices)).toBeNull();
    act(() => draft.takeFamilyPrices());
    expect(draft.editing).toBe(false);
    expect(draft.dirty).toBe(false);
    let began = true;
    act(() => {
      began = draft.startEditing();
    });
    expect(began).toBe(false);
    expect(draft.editing).toBe(false);
  });

  it("allowed: the button shows and takes the family prices into the draft", async () => {
    authUser = { id: "u1", role: "OPERATOR" };
    mockGet.mockResolvedValue({ data: { groups: ALL, version: 1, mode: "live" } });
    mount();
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("/users/me/permissions"));
    expect(screen.getByTestId(T.btnUseFamilyPrices)).toBeTruthy();
    act(() => draft.takeFamilyPrices());
    expect(draft.editing).toBe(true);
  });
});
