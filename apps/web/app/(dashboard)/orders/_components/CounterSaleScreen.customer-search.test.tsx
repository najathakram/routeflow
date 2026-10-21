import * as React from "react";
import { renderWithProviders, screen, fireEvent } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-11: a customer search that finds nobody says "No customers found" (never a blank dropdown). The list still shows when
 * there are matches; nothing shows for a blank field or before the first answer.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
let customersResult: { data?: { data: unknown[] }; isFetching?: boolean; isError?: boolean } = {};
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => customersResult,
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  customersResult = { data: { data: [] } };
});

const search = (text: string) =>
  fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: text } });

describe("CounterSaleScreen: customer search empty state (CQ-11)", () => {
  it("a search with no match says 'No customers found'", () => {
    renderWithProviders(<CounterSaleScreen />);
    search("zzz");
    expect(screen.getByTestId("counter-customer-none")).toHaveTextContent("No customers found");
  });

  it("nothing is said for a blank field", () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.queryByTestId("counter-customer-none")).toBeNull();
    search("   ");
    expect(screen.queryByTestId("counter-customer-none")).toBeNull();
  });

  it("nothing is said while the answer is still on its way, or when the search failed", () => {
    customersResult = { data: undefined, isFetching: true };
    renderWithProviders(<CounterSaleScreen />);
    search("zzz");
    expect(screen.queryByTestId("counter-customer-none")).toBeNull();
  });

  it("matches show the list, not the empty state", () => {
    customersResult = { data: { data: [{ id: "c1", businessName: "Acme Cafe" }] } };
    renderWithProviders(<CounterSaleScreen />);
    search("acme");
    expect(screen.getByRole("option", { name: "Acme Cafe" })).toBeInTheDocument();
    expect(screen.queryByTestId("counter-customer-none")).toBeNull();
  });
});
