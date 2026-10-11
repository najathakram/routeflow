import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { PosFinishError, isPosOrder, usePosFinish } from "./pos-orders";
import { apiClient } from "@/lib/api-client";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));

const wrapper = (qc: QueryClient) =>
  function W({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

describe("isPosOrder", () => {
  it("is PICKUP and not a counter sale", () => {
    expect(isPosOrder({ fulfillPath: "PICKUP", counterSale: false })).toBe(true);
    expect(isPosOrder({ fulfillPath: "PICKUP" })).toBe(true);
    expect(isPosOrder({ fulfillPath: "PICKUP", counterSale: true })).toBe(false);
    expect(isPosOrder({ fulfillPath: "ROUTE" })).toBe(false);
  });
});

describe("usePosFinish", () => {
  beforeEach(() => jest.clearAllMocks());

  it("renders its own errors (no global toast) and keeps the underlying .response on the error", async () => {
    const response = { status: 409, data: { code: "X" } };
    (apiClient.patch as jest.Mock).mockRejectedValue({ response });
    const qc = new QueryClient();
    const { result } = renderHook(() => usePosFinish(), { wrapper: wrapper(qc) });
    let err: unknown;
    await act(async () => {
      err = await result.current.mutateAsync({ orderId: "o1", invoice: true }).catch((e) => e);
    });
    expect(err).toBeInstanceOf(PosFinishError);
    expect((err as PosFinishError).step).toBe("confirm");
    expect((err as PosFinishError).response).toBe(response);
    expect(qc.getMutationCache().getAll()[0].options.meta).toEqual({ localErrorToast: true });
  });
  it("a DRAFT target is promoted to PENDING before CONFIRMED (the API has no DRAFT -> CONFIRMED edge)", async () => {
    (apiClient.patch as jest.Mock).mockResolvedValue({ data: { id: "o1" } });
    const { result } = renderHook(() => usePosFinish(), { wrapper: wrapper(new QueryClient()) });
    await act(async () => {
      await result.current.mutateAsync({ orderId: "o1", invoice: false, fromStatus: "DRAFT" });
    });
    expect((apiClient.patch as jest.Mock).mock.calls.map((c) => c[1].status)).toEqual([
      "PENDING",
      "CONFIRMED",
    ]);
  });
});
