/**
 * `useProductsByIds` (P-21, 573): one helper reads products by id in chunks of 200. Dedupes, sorts, merges,
 * and does not run at all with no ids. Real hook, mocked HTTP client.
 */
import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { chunkIds, useProductsByIds } from "./products";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const mockedGet = apiClient.get as jest.Mock;

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (n: number) => Array.from({ length: n }, (_, i) => id(i + 1));

/** The server's answer to one chunk: a row per requested id. */
const answerByIds = (_url: string, cfg: { params: { ids: string } }) =>
  Promise.resolve({
    data: {
      data: cfg.params.ids.split(",").map((pid) => ({ id: pid, name: `P ${pid.slice(-4)}` })),
    },
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockedGet.mockImplementation(answerByIds);
});

describe("useProductsByIds", () => {
  it("I7: 450 ids make 3 requests (200, 200, 50) and give one merged list", async () => {
    const { result } = renderHook(() => useProductsByIds(ids(450)), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedGet).toHaveBeenCalledTimes(3);
    const sizes = mockedGet.mock.calls.map((c) => c[1].params.ids.split(",").length).sort();
    expect(sizes).toEqual([200, 200, 50].sort());
    expect(result.current.data).toHaveLength(450);
    expect(new Set(result.current.data.map((p: { id: string }) => p.id)).size).toBe(450);
  });

  it("asks for /products with only the ids: no limit=0, no isActive", async () => {
    const { result } = renderHook(() => useProductsByIds([id(2), id(1)]), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedGet).toHaveBeenCalledWith("/products", { params: { ids: `${id(1)},${id(2)}` } });
  });

  it("dedupes and sorts, so the same set in any order is one request and one cache entry", async () => {
    const { result } = renderHook(() => useProductsByIds([id(2), id(1), id(2)]), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(result.current.data.map((p: { id: string }) => p.id)).toEqual([id(1), id(2)]);
  });

  it("with no ids it makes no request and reports nothing loading", () => {
    const { result } = renderHook(() => useProductsByIds([]), { wrapper: Wrapper });
    expect(mockedGet).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(false);
  });

  it("reports an error when a chunk fails", async () => {
    mockedGet.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useProductsByIds([id(1)]), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("chunkIds", () => {
  it("splits at 200 and keeps the order", () => {
    expect(chunkIds(ids(401)).map((c) => c.length)).toEqual([200, 200, 1]);
    expect(chunkIds([])).toEqual([]);
  });
});
