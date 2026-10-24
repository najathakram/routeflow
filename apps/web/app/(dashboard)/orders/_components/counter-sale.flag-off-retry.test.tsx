import * as React from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCounterReprice } from "./useCounterReprice";

// Review item 5 (flag-off breach): with flag.units_prices_v2 off, Retry must not run the DISABLED price-layer query
// (TanStack v5 refetch() runs it anyway -> 403 PLAN_GATE + an upgrade toast). The REAL useCustomerPriceLayer is used here.
const get = jest.fn().mockResolvedValue({ data: {} });
jest.mock("@/lib/api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));
jest.mock("@/lib/api/units-v2", () => ({ usePricesV2Enabled: () => false }));
jest.mock("@/lib/api/customers", () => ({
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api/tier-labels", () => ({ useTierLabels: () => ({ data: undefined }) }));

it("flag off: retry() fires no /price-layer request", () => {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useCounterReprice({
        customer: { id: "c1", businessName: "Acme", pricingTier: 3 },
        lines: [],
        setLines: jest.fn(),
        locked: false,
      }),
    { wrapper },
  );
  result.current.retry();
  expect(get.mock.calls.filter((c) => String(c[0]).includes("price-layer"))).toHaveLength(0);
});
