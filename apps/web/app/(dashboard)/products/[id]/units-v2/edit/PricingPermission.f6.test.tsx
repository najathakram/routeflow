import * as React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ProductPriceGridDto } from "@routeflow/types";
import { ProductPricingV2 } from "../../ProductPricingV2";
import { UNITS_V2_TESTIDS as T } from "../../units-v2-testids";
import { GRID, PRODUCT } from "../window/k11-20a.fixtures";

// W-1170 F6: the server refuses POST /products/:id/prices (and /undo) with 403 for an operator whose PRICING group is
// off, so the grid stays readable but offers no Edit, no Change prices and no clickable price.

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
jest.mock("@/lib/api/tier-labels", () => ({
  useTierLabels: () => ({ data: { "2": "Wholesale", "3": "Distributor" } }),
}));
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => true }));
jest.mock("@/lib/api/useProductCustomerPrices", () => ({
  ...jest.requireActual("@/lib/api/useProductCustomerPrices"),
  useProductCustomerPrices: () => ({ data: { customers: [] }, isFetching: false }),
}));

const ALL = ["SELLING", "PRICING", "INVENTORY"];
const mount = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ProductPricingV2 product={PRODUCT} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  mockGet.mockReset();
  mockGrid = { data: GRID, isLoading: false, isError: false };
});

describe("W-1170 F6: price edit controls follow the PRICING group", () => {
  it("an operator without PRICING sees the grid but no Edit, no Change prices, no price buttons", async () => {
    authUser = { id: "u1", role: "OPERATOR" };
    mockGet.mockResolvedValue({
      data: { groups: ALL.filter((g) => g !== "PRICING"), version: 1, mode: "live" },
    });
    mount();
    expect(await screen.findByText("Ask an admin for pricing access.")).toBeTruthy();
    expect(screen.queryByTestId(T.btnEdit)).toBeNull();
    expect(screen.queryByTestId(T.btnChange)).toBeNull();
    const row = within(screen.getByTestId(T.row("case")));
    expect(row.queryByRole("button", { name: /^Edit /i })).toBeNull();
    expect(row.getAllByText(/\$13\.91/).length).toBeGreaterThan(0);
  });

  it("an operator with PRICING keeps Edit and the note stays away", async () => {
    authUser = { id: "u1", role: "OPERATOR" };
    mockGet.mockResolvedValue({ data: { groups: ALL, version: 1, mode: "live" } });
    mount();
    await waitFor(() => expect(mockGet).toHaveBeenCalled());
    const edit = screen.getByTestId(T.btnEdit) as HTMLButtonElement;
    expect(edit.disabled).toBe(false);
    expect(screen.queryByText("Ask an admin for pricing access.")).toBeNull();
  });

  it("an account admin asks nothing and keeps Edit", () => {
    authUser = { id: "a1", role: "TENANT_ADMIN" };
    mount();
    expect(mockGet).not.toHaveBeenCalledWith("/users/me/permissions");
    expect(screen.getByTestId(T.btnEdit)).toBeTruthy();
  });
});
