import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useProductsByIds } from "./purchase-order-products";

const get = jest.fn();
jest.mock("../api-client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return Wrapper;
};

describe("useProductsByIds", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) =>
      Promise.resolve({ data: { id: url.split("/").pop(), name: "Row" } }),
    );
  });

  it("reads each distinct id from /products/:id, never the catalog list", async () => {
    const { result } = renderHook(() => useProductsByIds(["p1", "p2", "p1", ""]), {
      wrapper: wrap(),
    });
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual(["/products/p1", "/products/p2"]);
    expect(get).not.toHaveBeenCalledWith("/products", expect.anything());
  });

  it("makes no request when the order has no lines", () => {
    const { result } = renderHook(() => useProductsByIds([]), { wrapper: wrap() });
    expect(result.current.data).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
});
