import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProrationPreview } from "./billing";

/**
 * The add-on confirm sheet quotes a MONEY figure from this query, so a cached preview must
 * never be shown as current: every mount refetches, even under the app's 30s default staleTime.
 */
const get = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => get(...a) },
}));

function wrapperFor(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useProrationPreview", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: { sku: "ROUTE_PLUS", proratedToday: 10 } });
  });

  it("refetches on every mount even when the cache is fresh under the app-wide staleTime", async () => {
    // Mirrors app/providers.tsx: a 30s default staleTime that would otherwise serve the cache.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const first = renderHook(() => useProrationPreview("ROUTE_PLUS"), { wrapper: wrapperFor(qc) });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    expect(get).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = renderHook(() => useProrationPreview("ROUTE_PLUS"), {
      wrapper: wrapperFor(qc),
    });
    // The cached figure is there at once, but it is being re-checked.
    expect(second.result.current.data).toBeDefined();
    expect(second.result.current.isFetching).toBe(true);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});
