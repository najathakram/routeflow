import * as React from "react";
import { renderWithProviders, screen, fireEvent } from "@/test-utils/render";
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
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
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

let features: { data?: unknown; isLoading?: boolean; isError?: boolean } = {};
jest.mock("@/lib/tenant-features", () => ({ useTenantFeatures: () => features }));

const DISABLED_COPY = "Counter sales are not turned on for this business.";

const expectDark = () => {
  expect(screen.getByTestId("counter-sale-off")).toHaveTextContent(DISABLED_COPY);
  expect(screen.getByTestId("counter-sale-off").textContent).toBe(DISABLED_COPY);
  expect(screen.queryByLabelText("Scan or search items")).toBeNull();
  expect(screen.queryByRole("button", { name: "Complete & show receipt" })).toBeNull();
  expect(screen.queryByRole("radio", { name: "Cash" })).toBeNull();
  expect(screen.queryByTestId("counter-sale-screen")).toBeNull();
  expect(screen.queryByTestId("counter-sale-loading")).toBeNull();
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

  it("still loading: an empty non-interactive placeholder, NO copy (never a false 'not turned on')", () => {
    features = { data: undefined, isLoading: true };
    renderWithProviders(<CounterSaleScreen />);
    const placeholder = screen.getByTestId("counter-sale-loading");
    expect(placeholder.textContent).toBe("");
    expect(placeholder.querySelector("input, button, a")).toBeNull();
    expect(screen.queryByTestId("counter-sale-off")).toBeNull();
    expect(screen.queryByText(DISABLED_COPY)).toBeNull();
    expect(screen.queryByLabelText("Scan or search items")).toBeNull();
    expect(screen.queryByTestId("counter-sale-screen")).toBeNull();
  });

  it("loading resolves: the sale UI once the capability arrives, the disabled copy if it is off", () => {
    features = {
      data: { capabilities: { fulfilment: { counter: "optional" } } },
      isLoading: false,
    };
    const { unmount } = renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByLabelText("Scan or search items")).toBeInTheDocument();
    expect(screen.queryByTestId("counter-sale-loading")).toBeNull();
    unmount();
    features = { data: { capabilities: { fulfilment: { counter: "off" } } }, isLoading: false };
    renderWithProviders(<CounterSaleScreen />);
    expectDark();
    expect(screen.queryByTestId("counter-sale-loading")).toBeNull();
  });

  // CQ-30: a FAILED lookup is not the "off" answer: it says the check failed and offers Retry (still no sale UI).
  it("the features request errored: no sale UI, a retry state, never 'not turned on'", () => {
    const refetch = jest.fn();
    features = { data: undefined, isError: true, refetch } as typeof features;
    renderWithProviders(<CounterSaleScreen />);
    const offline = screen.getByTestId("counter-sale-offline");
    expect(offline).toHaveTextContent("Couldn't check whether counter sales are on.");
    expect(screen.queryByText(DISABLED_COPY)).toBeNull();
    expect(screen.queryByTestId("counter-sale-off")).toBeNull();
    expect(screen.queryByLabelText("Scan or search items")).toBeNull();
    expect(screen.queryByTestId("counter-sale-screen")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("a refetch error with an earlier answer keeps that answer (the sale UI stays)", () => {
    features = {
      data: { capabilities: { fulfilment: { counter: "optional" } } },
      isError: true,
    };
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByLabelText("Scan or search items")).toBeInTheDocument();
    expect(screen.queryByTestId("counter-sale-offline")).toBeNull();
  });

  it("a successful lookup that says off still shows 'not turned on'", () => {
    features = { data: { capabilities: { fulfilment: { counter: "off" } } }, isError: false };
    renderWithProviders(<CounterSaleScreen />);
    expectDark();
    expect(screen.queryByTestId("counter-sale-offline")).toBeNull();
  });

  it.each(["optional", "always"])("counter %s: the full sale UI", (counter) => {
    features = { data: { capabilities: { fulfilment: { counter } } } };
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByLabelText("Scan or search items")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete & show receipt" })).toBeInTheDocument();
    expect(screen.queryByTestId("counter-sale-off")).toBeNull();
  });
});
