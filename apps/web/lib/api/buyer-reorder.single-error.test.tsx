import * as React from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { useBuyerReorder } from "./buyer";
import { handleMutationError } from "../mutation-error-toast";

/**
 * A failed Place order shows the review sheet's own fixed sentence. The app-wide MutationCache toast
 * ("Something went wrong…") must NOT fire on top of it: the buyer would read two messages for one
 * failure. The reorder mutation opts out with `localErrorToast`, exactly like #3097's pattern.
 */
const post = jest.fn();
jest.mock("@/lib/buyer-api-client", () => ({
  buyerApiClient: { post: (...a: unknown[]) => post(...a), get: jest.fn() },
}));
jest.mock("@/lib/buyer-auth-context", () => ({}));

function client(toast: jest.Mock) {
  // The same wiring app/providers.tsx installs.
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _v, _c, mutation) =>
        handleMutationError(error, mutation as any, toast, { push: jest.fn() }),
    }),
    defaultOptions: { mutations: { retry: false } },
  });
}
const wrap = (qc: QueryClient) =>
  function W({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
const serverError = () =>
  Object.assign(new Error("Request failed"), {
    response: { status: 400, data: { message: "Product 9f3c-uuid not found" } },
  });

describe("useBuyerReorder — one error message per failure", () => {
  beforeEach(() => post.mockReset());

  it("with localErrorToast the global toast does NOT fire (only the caller's sentence shows)", async () => {
    post.mockRejectedValue(serverError());
    const toast = jest.fn();
    const { result } = renderHook(() => useBuyerReorder({ localErrorToast: true }), {
      wrapper: wrap(client(toast)),
    });
    await expect(result.current.mutateAsync("t1")).rejects.toBeDefined();
    expect(toast).not.toHaveBeenCalled();
  });

  it("without it the global toast fires (the control: the opt-out is what silences it)", async () => {
    post.mockRejectedValue(serverError());
    const toast = jest.fn();
    const { result } = renderHook(() => useBuyerReorder(), { wrapper: wrap(client(toast)) });
    await expect(result.current.mutateAsync("t1")).rejects.toBeDefined();
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
