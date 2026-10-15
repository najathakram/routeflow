import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { usePriceSummary } from "./price-history";
import type { PriceSummaryResponse } from "@routeflow/types";

const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

const entry = (price: number) => ({
  last3: [{ date: "2026-09-20T00:00:00.000Z", unitPrice: price, unitLabel: "case" }],
  low: price,
  high: price,
  unitLabel: "case",
  unitsPerBox: 24,
});

const wrap = (qc: QueryClient) => {
  const W = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return W;
};
const newQc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const idsParam = (call: unknown[]) => (call[1] as { params: Record<string, string> }).params;

describe("usePriceSummary", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockGet.mockImplementation((_url: string, cfg: { params: { productIds: string } }) =>
      Promise.resolve({
        data: Object.fromEntries(
          cfg.params.productIds.split(",").map((id) => [id, entry(10)]),
        ) as PriceSummaryResponse,
      }),
    );
  });

  it("sends ONE request with de-duplicated, sorted ids", async () => {
    const { result } = renderHook(() => usePriceSummary("c1", ["b", "a", "b", "c"]), {
      wrapper: wrap(newQc()),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0]![0]).toBe("/customers/c1/price-summary");
    expect(idsParam(mockGet.mock.calls[0]!).productIds).toBe("a,b,c");
    expect(idsParam(mockGet.mock.calls[0]!).excludeOrderId).toBeUndefined();
  });

  it("id order does not change the query (stable key, no refetch)", async () => {
    const qc = newQc();
    const { result, rerender } = renderHook(({ ids }) => usePriceSummary("c1", ids), {
      wrapper: wrap(qc),
      initialProps: { ids: ["a", "b"] },
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    rerender({ ids: ["b", "a", "a"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("passes excludeOrderId and keys on it", async () => {
    const { result } = renderHook(() => usePriceSummary("c1", ["a"], "ord-1"), {
      wrapper: wrap(newQc()),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(idsParam(mockGet.mock.calls[0]!).excludeOrderId).toBe("ord-1");
  });

  it("chunks more than 50 ids into requests of at most 50 and merges the results", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `p${String(i).padStart(3, "0")}`);
    const { result } = renderHook(() => usePriceSummary("c1", ids), { wrapper: wrap(newQc()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(mockGet).toHaveBeenCalledTimes(3);
    for (const c of mockGet.mock.calls) {
      expect(idsParam(c).productIds.split(",").length).toBeLessThanOrEqual(50);
    }
    expect(Object.keys(result.current.data!)).toHaveLength(120);
  });

  it("is disabled with no customer or no ids", async () => {
    renderHook(() => usePriceSummary(null, ["a"]), { wrapper: wrap(newQc()) });
    renderHook(() => usePriceSummary("c1", []), { wrapper: wrap(newQc()) });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("never shows the previous customer's data after a customer change (no placeholderData)", async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes("/c1/")
        ? Promise.resolve({ data: { a: entry(18.75) } })
        : new Promise(() => undefined),
    );
    const { result, rerender } = renderHook(({ c }) => usePriceSummary(c, ["a"]), {
      wrapper: wrap(newQc()),
      initialProps: { c: "c1" as string | null },
    });
    await waitFor(() => expect(result.current.data?.a?.low).toBe(18.75));
    rerender({ c: "c2" });
    expect(result.current.data).toBeUndefined();
    rerender({ c: null });
    expect(result.current.data).toBeUndefined();
  });
});
