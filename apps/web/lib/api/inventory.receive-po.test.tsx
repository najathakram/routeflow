import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useReceivePurchaseOrder } from "./inventory";

/**
 * B1477: after "Confirm receipt" the PO page's On hand (useProductsByIds, cached under ["products", ...]) must
 * refresh, not wait for a reload.
 */
const post = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: jest.fn() },
}));

describe("REG-B1477 useReceivePurchaseOrder refreshes the products cache", () => {
  it("invalidates the products set the PO page reads, besides inventory", async () => {
    post.mockResolvedValue({ data: { ok: true } });
    const qc = new QueryClient();
    qc.setQueryData(["products", "ids", ["p1"]], [{ id: "p1", currentStock: -27 }]);
    qc.setQueryData(["inventory", "stock"], []);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useReceivePurchaseOrder(), { wrapper });

    await act(async () => {
      result.current.mutate({ id: "po-1", items: [{ id: "l1", receivedQty: 48 }] });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryState(["products", "ids", ["p1"]])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["inventory", "stock"])?.isInvalidated).toBe(true);
  });
});
