import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useApproveInlineReturn, useRejectInlineReturn } from "./inline-returns";

/**
 * SA-1060 PR-1 (MUST 2): the two calls the held-returns screen makes, on the API's own routes. Each refreshes what the sale
 * touches: the returns lists, the order, the customer and the credit notes (an approve mints one).
 */
const mockPost = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { post: (...a: unknown[]) => mockPost(...a), get: jest.fn() },
}));

const setup = <T,>(hook: () => T) => {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const spy = jest.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { spy, ...renderHook(hook, { wrapper }) };
};
const keysOf = (spy: jest.SpyInstance) =>
  spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown }).queryKey));

beforeEach(() => mockPost.mockReset());

describe("useApproveInlineReturn", () => {
  it("POSTs /returns/inline/:id/approve with only what the screen was given", async () => {
    mockPost.mockResolvedValueOnce({ data: { id: "ret-1", orderId: "o1", customerId: "c1" } });
    const { result, spy } = setup(() => useApproveInlineReturn());
    await act(async () => {
      await result.current.mutateAsync({ id: "ret-1", reason: "Receipt shown" });
    });
    expect(mockPost).toHaveBeenCalledWith("/returns/inline/ret-1/approve", {
      reason: "Receipt shown",
    });
    const keys = keysOf(spy);
    expect(keys).toEqual(
      expect.arrayContaining([
        '["returns"]',
        '["orders"]',
        '["credit-notes"]',
        '["customers","c1"]',
      ]),
    );
  });

  it("a plain approve sends an empty body", async () => {
    mockPost.mockResolvedValueOnce({ data: { id: "ret-1", orderId: "o1", customerId: "c1" } });
    const { result } = setup(() => useApproveInlineReturn());
    await act(async () => {
      await result.current.mutateAsync({ id: "ret-1" });
    });
    expect(mockPost).toHaveBeenCalledWith("/returns/inline/ret-1/approve", {});
  });
});

describe("useRejectInlineReturn", () => {
  it("POSTs /returns/inline/:id/reject and refreshes the returns lists", async () => {
    mockPost.mockResolvedValueOnce({ data: { id: "ret-1", orderId: "o1", customerId: "c1" } });
    const { result, spy } = setup(() => useRejectInlineReturn());
    await act(async () => {
      await result.current.mutateAsync({ id: "ret-1" });
    });
    expect(mockPost).toHaveBeenCalledWith("/returns/inline/ret-1/reject", {});
    expect(keysOf(spy)).toEqual(expect.arrayContaining(['["returns"]']));
  });
});
