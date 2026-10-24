import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useAddRuleTargets,
  useCreateRestriction,
  useEditRule,
  useLiftRestriction,
  useRemoveRuleTargets,
  useRuleEditPreview,
} from "./restrictions-admin-write";

const post = jest.fn();
const put = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), put: (...a: unknown[]) => put(...a) },
}));

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

describe("row 509 rule hooks", () => {
  it("create passes `targets` through untouched", async () => {
    post.mockResolvedValueOnce({ data: { id: "r1" } });
    const { wrapper } = setup();
    const { result } = renderHook(() => useCreateRestriction(), { wrapper });
    const body = {
      targets: { productIds: ["p1", "p2"], categoryIds: ["c1"] },
      jurisdiction: "FEDERAL" as const,
      reason: "law",
    };
    await act(async () => {
      await result.current.mutateAsync(body);
    });
    expect(post).toHaveBeenCalledWith("/selling-restrictions", body);
  });

  it("add posts the ids to the rule's targets route and refreshes the whole prefix", async () => {
    post.mockResolvedValueOnce({
      data: { added: 2, skippedIds: [], addedTargetIds: ["t1", "t2"], activeTargets: 5 },
    });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useAddRuleTargets(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "r1", targets: { productIds: ["p1", "p2"] } });
    });
    expect(post).toHaveBeenCalledWith("/selling-restrictions/r1/targets", {
      productIds: ["p1", "p2"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["selling-restrictions"] });
  });

  it("remove posts the ids with the reason (only when given)", async () => {
    post.mockResolvedValue({ data: { removed: 1, notInRule: [], activeTargets: 4 } });
    const { wrapper, invalidate } = setup();
    const { result } = renderHook(() => useRemoveRuleTargets(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        id: "r1",
        targets: { productIds: ["p1"], categoryIds: ["c1"] },
        reason: "  Discontinued ",
      });
    });
    expect(post).toHaveBeenLastCalledWith("/selling-restrictions/r1/targets/remove", {
      productIds: ["p1"],
      categoryIds: ["c1"],
      reason: "Discontinued",
    });
    await act(async () => {
      await result.current.mutateAsync({ id: "r1", targets: { productIds: ["p2"] } });
    });
    expect(post).toHaveBeenLastCalledWith("/selling-restrictions/r1/targets/remove", {
      productIds: ["p2"],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["selling-restrictions"] });
  });

  it("edit-preview posts the settings; edit PUTs them with the revision and hash", async () => {
    post.mockResolvedValueOnce({
      data: { changes: [], impact: { openOrders: 0, drafts: 0 }, impactHash: "h1", revision: 3 },
    });
    put.mockResolvedValueOnce({ data: { id: "r1" } });
    const { wrapper, invalidate } = setup();
    const preview = renderHook(() => useRuleEditPreview(), { wrapper });
    const edit = renderHook(() => useEditRule(), { wrapper });
    const body = {
      jurisdiction: "STATE" as const,
      states: ["TX"],
      surface: "ALL" as const,
      reason: "x",
    };
    await act(async () => {
      await preview.result.current.mutateAsync({ id: "r1", body });
    });
    expect(post).toHaveBeenCalledWith("/selling-restrictions/r1/edit-preview", body);
    expect(invalidate).not.toHaveBeenCalled(); // a preview writes nothing
    await act(async () => {
      await edit.result.current.mutateAsync({
        id: "r1",
        body: { ...body, expectedRevision: 3, confirmImpactHash: "h1" },
      });
    });
    expect(put).toHaveBeenCalledWith("/selling-restrictions/r1", {
      ...body,
      expectedRevision: 3,
      confirmImpactHash: "h1",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["selling-restrictions"] });
  });
});
