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
  last3: [
    { date: "2026-09-20T00:00:00.000Z", unitPrice: price, unitLabel: "case", unitsPerBox: 24 },
  ],
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

  it("same customer, a product is added: the old entries stay while the new key loads", async () => {
    let release: (v: unknown) => void = () => undefined;
    mockGet.mockImplementation((_u: string, cfg: { params: { productIds: string } }) =>
      cfg.params.productIds === "a"
        ? Promise.resolve({ data: { a: entry(18.75) } })
        : new Promise((r) => {
            release = r;
          }),
    );
    const { result, rerender } = renderHook(({ ids }) => usePriceSummary("c1", ids), {
      wrapper: wrap(newQc()),
      initialProps: { ids: ["a"] },
    });
    await waitFor(() => expect(result.current.data?.a?.low).toBe(18.75));
    rerender({ ids: ["a", "b"] }); // new key, request pending
    expect(result.current.isFetching).toBe(true);
    expect(result.current.data?.a?.low).toBe(18.75); // chips do not blank
    release({ data: { a: entry(18.75), b: entry(5) } });
    await waitFor(() => expect(result.current.data?.b?.low).toBe(5));
  });

  it("a customer change after adding a product still shows nothing of the old customer", async () => {
    mockGet.mockImplementation((url: string) =>
      url.includes("/c1/")
        ? Promise.resolve({ data: { a: entry(18.75) } })
        : new Promise(() => undefined),
    );
    const { result, rerender } = renderHook(({ c, ids }) => usePriceSummary(c, ids), {
      wrapper: wrap(newQc()),
      initialProps: { c: "c1" as string | null, ids: ["a"] },
    });
    await waitFor(() => expect(result.current.data?.a?.low).toBe(18.75));
    rerender({ c: "c2", ids: ["a", "b"] }); // customer AND ids change together
    expect(result.current.data).toBeUndefined();
  });

  it("passes the react-query abort signal to the request", async () => {
    const { result } = renderHook(() => usePriceSummary("c1", ["a"]), { wrapper: wrap(newQc()) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const cfg = mockGet.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(cfg.signal).toBeInstanceOf(AbortSignal);
  });

  it("one chunk rejecting fails the whole batch: no data, an error, never a partial merge", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `p${String(i).padStart(3, "0")}`);
    mockGet.mockImplementation((_u: string, cfg: { params: { productIds: string } }) =>
      cfg.params.productIds.startsWith("p050")
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({
            data: Object.fromEntries(cfg.params.productIds.split(",").map((id) => [id, entry(10)])),
          }),
    );
    const { result } = renderHook(() => usePriceSummary("c1", ids), { wrapper: wrap(newQc()) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
