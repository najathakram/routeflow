import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreateCounterSale } from "./counter-sale";

/**
 * SA-1068 M9 (T8): a sale rung for a named customer invalidates that customer's remembered prices by their exact key, so the
 * next sale for them reads this one's price. A walk-in has no customer and nothing to invalidate.
 */
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { post: (...a: unknown[]) => mockPost(...a), get: jest.fn() },
}));

const setup = () => {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const spy = jest.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, spy, ...renderHook(() => useCreateCounterSale(), { wrapper }) };
};
const ok = { data: { orderId: "o-1", orderNumber: "ORD-70001", paymentRecorded: true } };

describe("T8: a counter sale refreshes the customer's remembered prices", () => {
  it("a named sale invalidates ['orders','price-history',customerId]", async () => {
    mockPost.mockResolvedValueOnce(ok);
    const { result, spy } = setup();
    await act(async () => {
      await result.current.mutateAsync({
        dto: { customerId: "c1", items: [] } as any,
        idempotencyKey: "k",
      });
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["orders", "price-history", "c1"] });
  });

  it("a walk-in sale invalidates no customer's prices", async () => {
    mockPost.mockResolvedValueOnce(ok);
    const { result, spy } = setup();
    await act(async () => {
      await result.current.mutateAsync({
        dto: { walkIn: true, items: [] } as any,
        idempotencyKey: "k2",
      });
    });
    const keys = spy.mock.calls.map((c) =>
      JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
    );
    expect(keys.some((k) => k.includes("price-history"))).toBe(false);
  });
});
