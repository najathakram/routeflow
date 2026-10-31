import * as React from "react";
import { renderHook, act } from "@testing-library/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { handleMutationError } from "@/lib/mutation-error-toast";

/**
 * Row 380: a stale buyer save is shown by the order page itself (its own notice + Reload), so the global
 * mutation toast stays quiet for ORDER_REVISION_STALE. Any other refusal still gets the generic toast.
 */
const patch = jest.fn();
jest.mock("@/lib/buyer-api-client", () => ({
  buyerApiClient: { patch: (...a: unknown[]) => patch(...a) },
}));

import { useBuyerUpdateOrderItems } from "./buyer";

function setup() {
  const toast = jest.fn();
  const qc: QueryClient = new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _v, _c, mutation) =>
        handleMutationError(error, mutation, toast, { push: jest.fn() } as never, {
          view: () => undefined,
          refresh: () => undefined,
          isAdmin: () => false,
        }),
    }),
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { toast, ...renderHook(() => useBuyerUpdateOrderItems(), { wrapper }) };
}

const refuse = (data: Record<string, unknown>) =>
  Object.assign(new Error("409"), { response: { status: 409, data } });

describe("useBuyerUpdateOrderItems global toast (row 380)", () => {
  it("a stale revision raises no generic toast", async () => {
    patch.mockRejectedValueOnce(refuse({ code: "ORDER_REVISION_STALE" }));
    const { toast, result } = setup();
    await act(async () => {
      await result.current
        .mutateAsync({ orderId: "o1", items: [], expectedRevisionNumber: 1 })
        .catch(() => undefined);
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("GUARD: another 409 still gets the generic toast", async () => {
    patch.mockRejectedValueOnce(refuse({ message: "x" }));
    const { toast, result } = setup();
    await act(async () => {
      await result.current.mutateAsync({ orderId: "o1", items: [] }).catch(() => undefined);
    });
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
