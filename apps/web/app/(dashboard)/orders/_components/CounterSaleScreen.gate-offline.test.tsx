import * as React from "react";
import { act } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { COUNTER_SALES_DISABLED_COPY } from "@/lib/counter-sale";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * CQ-30 (S3): the screen opened with the browser OFFLINE and no cached features. React Query PAUSES the lookup (not loading, not
 * an error), which used to fall through to "Counter sales are not turned on". Real useCounterSaleGate + real useTenantFeatures
 * over a real QueryClient: the screen says it could not check, Retry gives feedback, and the paused lookup resumes by itself.
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

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  get.mockImplementation((url: string) =>
    url === "/tenants/me/features"
      ? Promise.resolve({ data: { capabilities: { fulfilment: { counter: "always" } } } })
      : Promise.resolve({ data: { taxRate: 0 } }),
  );
  onlineManager.setOnline(false);
});
afterEach(() => onlineManager.setOnline(true));

describe("CounterSaleScreen: opened offline with nothing cached (CQ-30)", () => {
  it("says it could not check, never 'not turned on', and no sale UI", async () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(await screen.findByTestId("counter-sale-offline")).toBeInTheDocument();
    expect(screen.queryByText(COUNTER_SALES_DISABLED_COPY)).toBeNull();
    expect(screen.queryByTestId("counter-sale-off")).toBeNull();
    expect(screen.queryByLabelText("Scan or search items")).toBeNull();
    expect(get).not.toHaveBeenCalledWith("/tenants/me/features");
  });

  it("Retry shows 'Retrying...' and is disabled meanwhile; the paused lookup resumes when the network returns", async () => {
    renderWithProviders(<CounterSaleScreen />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    const busy = screen.getByRole("button", { name: /Retrying/ });
    expect(busy).toBeDisabled();
    act(() => onlineManager.setOnline(true));
    expect(await screen.findByLabelText("Scan or search items")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("counter-sale-offline")).toBeNull());
  });
});
