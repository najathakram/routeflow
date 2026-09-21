import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useCreateRestriction, useLiftRestriction } from "./restrictions-admin-write";

const post = jest.fn();
jest.mock("../api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = jest.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { wrapper, invalidate };
}
beforeEach(() => jest.clearAllMocks());

describe("restriction write hooks", () => {
  it("create posts the body and refreshes the cached rules lists", async () => {
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCreateRestriction(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        categoryId: "c1",
        jurisdiction: "FEDERAL",
        reason: "law",
      });
    });
    expect(post).toHaveBeenCalledWith("/selling-restrictions", {
      categoryId: "c1",
      jurisdiction: "FEDERAL",
      reason: "law",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["selling-restrictions"] });
  });

  it("lift posts to the rule's lift route with just the reason", async () => {
    post.mockResolvedValueOnce({ data: { id: "r1", status: "LIFTED" } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useLiftRestriction(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "r1", reason: "Law repealed" });
    });
    expect(post).toHaveBeenCalledWith("/selling-restrictions/r1/lift", { reason: "Law repealed" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["selling-restrictions"] });
  });

  it("a failed create refreshes nothing (and leaves the error to the global toast)", async () => {
    post.mockRejectedValueOnce(new Error("nope"));
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useCreateRestriction(), { wrapper });
    await act(async () => {
      await result.current
        .mutateAsync({ categoryId: "c1", jurisdiction: "FEDERAL", reason: "x" })
        .catch(() => {});
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
