import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCounterSaleByKey, useCreateCounterSale } from "./counter-sale";
import { wasCreatedHere } from "@/lib/order-created-echo";

/**
 * W-708: the till's own sale must not come back as a "New order placed" toast. The realtime `order.created` handler skips
 * an order this tab recorded with `markOrderCreatedHere` (row 604 F17, lib/order-created-echo.ts); the counter sale never
 * recorded its order, so ~1.5 s after Complete the toast landed on the receipt, covering Print and Email at 390.
 */
const mockPost = jest.fn();
const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    post: (...a: unknown[]) => mockPost(...a),
    get: (...a: unknown[]) => mockGet(...a),
  },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

const sale = (orderNumber: string) => ({
  data: { orderId: `o-${orderNumber}`, orderNumber, paymentRecorded: true },
});

describe("W-708: the counter's own sale is recorded as created here", () => {
  it("a completed counter sale's order number is the tab's own (no realtime toast for it)", async () => {
    mockPost.mockResolvedValueOnce(sale("ORD-90001"));
    const { result } = renderHook(() => useCreateCounterSale(), { wrapper });
    expect(wasCreatedHere("ORD-90001")).toBe(false);
    await act(async () => {
      await result.current.mutateAsync({ dto: {} as any, idempotencyKey: "k-1" });
    });
    expect(wasCreatedHere("ORD-90001")).toBe(true);
  });

  it("a sale recovered by its Idempotency-Key (Check sale status) is the tab's own too", async () => {
    mockGet.mockResolvedValueOnce(sale("ORD-90002"));
    const { result } = renderHook(() => useCounterSaleByKey(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ idempotencyKey: "k-2", method: "CASH" as any });
    });
    expect(wasCreatedHere("ORD-90002")).toBe(true);
  });

  it("another tab's or another cashier's order is still announced", () => {
    expect(wasCreatedHere("ORD-99999")).toBe(false);
  });
});
