import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";

jest.mock("@/lib/buyer-api-client", () => ({
  __esModule: true,
  default: { post: jest.fn().mockRejectedValue(new Error("boom")) },
  buyerApiClient: { post: jest.fn().mockRejectedValue(new Error("boom")) },
}));

const refusal = (code: string) => ({ response: { status: 409, data: { code, orderId: "o-1" } } });

describe("useBuyerCreateOrder suppresses the global toast only for the order-exists refusals", () => {
  it("meta.localErrorToast is true for the idempotency refusals and false otherwise", async () => {
    const { useBuyerCreateOrder } = await import("./buyer");
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useBuyerCreateOrder(), { wrapper });
    await act(async () => {
      result.current.mutate({ items: [] }, { onError: () => undefined });
    });
    const flag = qc.getMutationCache().getAll()[0]?.meta?.localErrorToast as (
      e: unknown,
    ) => boolean;
    expect(typeof flag).toBe("function");
    expect(flag(refusal("IDEMPOTENCY_KEY_CONFLICT"))).toBe(true);
    expect(flag(refusal("IDEMPOTENCY_KEY_CART_MISMATCH"))).toBe(true);
    expect(flag(refusal("IDEMPOTENCY_KEY_DRAFT_MISMATCH"))).toBe(true);
    expect(flag(refusal("SOMETHING_ELSE"))).toBe(false);
  });
});
