import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * The screen route goes through the REAL useCounterSaleGate (only GET /tenants/me/features is mocked): a missing, loading,
 * errored, unknown or "off" capability renders NO sale UI (no scan field, no cart, no payment), only the approved disabled
 * copy. "optional" / "always" render the full UI. A missing capability is DARK, never open.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/products", () => ({
  useProducts: () => ({ data: undefined, isFetching: false }),
}));
jest.mock("@/lib/api/customers", () => ({ useCustomers: () => ({ data: { data: [] } }) }));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));

let features: { data?: unknown; isLoading?: boolean; isError?: boolean } = {};
jest.mock("@/lib/tenant-features", () => ({ useTenantFeatures: () => features }));

const DISABLED_COPY = "Counter sales are not turned on for this business.";

const expectDark = () => {
  expect(screen.getByTestId("counter-sale-off")).toHaveTextContent(DISABLED_COPY);
  expect(screen.getByTestId("counter-sale-off").textContent).toBe(DISABLED_COPY);
  expect(screen.queryByLabelText("Scan or search items")).toBeNull();
  expect(screen.queryByRole("button", { name: "Complete sale" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cash" })).toBeNull();
  expect(screen.queryByTestId("counter-sale-screen")).toBeNull();
};

describe("CounterSaleScreen: the capability gate (missing means dark)", () => {
  beforeEach(() => {
    features = {};
  });

  it("a features response WITHOUT capabilities: no sale UI, only the disabled copy", () => {
    features = { data: { tenantId: "t1" } };
    renderWithProviders(<CounterSaleScreen />);
    expectDark();
  });

  it("a features response with capabilities but no fulfilment: dark", () => {
    features = { data: { capabilities: {} } };
    renderWithProviders(<CounterSaleScreen />);
    expectDark();
  });

  it("counter off: no sale UI, only the disabled copy", () => {
    features = { data: { capabilities: { fulfilment: { counter: "off" } } } };
    renderWithProviders(<CounterSaleScreen />);
    expectDark();
  });

  it("an unknown counter value: dark", () => {
    features = { data: { capabilities: { fulfilment: { counter: "bogus" } } } };
    renderWithProviders(<CounterSaleScreen />);
    expectDark();
  });

  it("still loading: no scan field", () => {
    features = { data: undefined, isLoading: true };
    renderWithProviders(<CounterSaleScreen />);
    expectDark();
  });

  it("the features request errored: dark", () => {
    features = { data: undefined, isError: true };
    renderWithProviders(<CounterSaleScreen />);
    expectDark();
  });

  it.each(["optional", "always"])("counter %s: the full sale UI", (counter) => {
    features = { data: { capabilities: { fulfilment: { counter } } } };
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByLabelText("Scan or search items")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete sale" })).toBeInTheDocument();
    expect(screen.queryByTestId("counter-sale-off")).toBeNull();
  });
});
