import * as React from "react";
import { renderWithProviders, screen, waitFor, fireEvent, act } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-30 follow-up: pressing Retry on the "couldn't check" panel left it for a blank page for the length of the refetch (a
 * failed lookup with no data flips back to loading, and the loading placeholder is empty). Real gate over a real QueryClient
 * with a refetch that is held open: the panel stays mounted, reads "Retrying...", and only then gives way to the sale UI, or
 * comes back as the panel when the retry fails again. There is never a render with neither.
 */
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
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
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
const get = apiClient.get as unknown as jest.Mock;

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
let pending: Deferred | null;
let featureCalls: number;

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  featureCalls = 0;
  pending = null;
  get.mockImplementation((url: string) => {
    if (url !== "/tenants/me/features") return Promise.resolve({ data: { taxRate: 0 } });
    featureCalls += 1;
    if (featureCalls === 1) return Promise.reject({ response: { status: 500 } });
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
  });
});

const shell = () => screen.getByTestId("counter-sale-offline");
// Every committed render must show the panel, the sale UI or the off copy: never neither.
const neverBlank = () => {
  expect(screen.queryByTestId("counter-sale-loading")).toBeNull();
};

describe("CounterSaleScreen: the retry panel through a refetch (CQ-30)", () => {
  it("stays mounted with 'Retrying...' for the whole refetch, then opens the sale UI", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(featureCalls).toBe(2)); // the refetch is now in flight and held open
    neverBlank();
    expect(shell()).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retrying/ })).toBeDisabled();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    neverBlank();
    expect(shell()).toBeInTheDocument();

    await act(async () => {
      pending?.resolve({ data: { capabilities: { fulfilment: { counter: "always" } } } });
    });
    expect(await screen.findByLabelText("Scan or search items")).toBeInTheDocument();
    expect(screen.queryByTestId("counter-sale-offline")).toBeNull();
  });

  it("a retry that fails again brings the panel back, still never blank", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(featureCalls).toBe(2));
    neverBlank();
    await act(async () => {
      pending?.reject({ response: { status: 503 } });
    });
    await waitFor(() => expect(shell()).toBeInTheDocument());
    neverBlank();
    expect(screen.queryByLabelText("Scan or search items")).toBeNull();
    expect(screen.queryByText("Counter sales are not turned on for this business.")).toBeNull();
  });
});
