import * as React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCreateTenantUnit, useTenantUnits, useUpdateTenantUnit } from "./tenant-units";

const get = jest.fn();
const post = jest.fn();
const patch = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, Wrapper };
}

beforeEach(() => jest.clearAllMocks());

describe("tenant-units hooks", () => {
  it("lists the ACTIVE units in one request and the ARCHIVED ones by page (SA-810)", async () => {
    get.mockImplementation(async (_url: string, opts?: { params?: Record<string, unknown> }) => {
      if (!opts?.params?.archived)
        return { data: [{ id: "a", name: "Case", archivedAt: null, productCount: 0 }] };
      if (!opts.params.cursor) {
        return {
          data: {
            items: [{ id: "o1", name: "Old", archivedAt: "2026-10-01T00:00:00Z", productCount: 0 }],
            nextCursor: "c1",
          },
        };
      }
      return {
        data: {
          items: [{ id: "o2", name: "Older", archivedAt: "2026-10-01T00:00:00Z", productCount: 0 }],
          nextCursor: null,
        },
      };
    });
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useTenantUnits(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(get).toHaveBeenCalledWith("/units");
    expect(get).toHaveBeenCalledWith("/units", { params: { archived: 1 } });
    expect(result.current.data?.map((u) => u.id)).toEqual(["a", "o1"]);
    expect(result.current.hasMoreArchived).toBe(true);
    await act(async () => {
      await result.current.fetchMoreArchived();
    });
    await waitFor(() => expect(result.current.data?.map((u) => u.id)).toEqual(["a", "o1", "o2"]));
    expect(get).toHaveBeenCalledWith("/units", { params: { archived: 1, cursor: "c1" } });
    expect(result.current.hasMoreArchived).toBe(false);
  });

  it("create posts {name}; rename and archive patch separately; all refresh the list", async () => {
    post.mockResolvedValue({ data: { id: "u1" } });
    patch.mockResolvedValue({ data: { unit: { id: "u1" }, productsUpdated: 0 } });
    const { qc, Wrapper } = wrapper();
    const spy = jest.spyOn(qc, "invalidateQueries");
    const create = renderHook(() => useCreateTenantUnit(), { wrapper: Wrapper });
    const update = renderHook(() => useUpdateTenantUnit(), { wrapper: Wrapper });
    await act(async () => {
      await create.result.current.mutateAsync({ name: "Case" });
      await update.result.current.mutateAsync({ id: "u1", name: "Carton" });
      await update.result.current.mutateAsync({ id: "u1", archived: true });
    });
    expect(post).toHaveBeenCalledWith("/units", { name: "Case" });
    expect(patch).toHaveBeenNthCalledWith(1, "/units/u1", { name: "Carton" });
    expect(patch).toHaveBeenNthCalledWith(2, "/units/u1", { archived: true });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("a rename also refreshes the product lists (their labels changed)", async () => {
    patch.mockResolvedValue({ data: { unit: { id: "u1" }, productsUpdated: 2 } });
    const { qc, Wrapper } = wrapper();
    const spy = jest.spyOn(qc, "invalidateQueries");
    const update = renderHook(() => useUpdateTenantUnit(), { wrapper: Wrapper });
    await act(async () => {
      await update.result.current.mutateAsync({ id: "u1", name: "Carton" });
    });
    const keys = spy.mock.calls.map(([a]) => JSON.stringify((a as { queryKey: unknown }).queryKey));
    expect(keys).toContain(JSON.stringify(["products"]));
  });

  it("the mutations own their error UI: meta.localErrorToast is set (no double toast, B594)", async () => {
    post.mockRejectedValue(new Error("x"));
    const { qc, Wrapper } = wrapper();
    const create = renderHook(() => useCreateTenantUnit(), { wrapper: Wrapper });
    const update = renderHook(() => useUpdateTenantUnit(), { wrapper: Wrapper });
    await act(async () => {
      await create.result.current.mutateAsync({ name: "Case" }).catch(() => undefined);
    });
    await act(async () => {
      await update.result.current.mutateAsync({ id: "u1", archived: true }).catch(() => undefined);
    });
    const metas = qc
      .getMutationCache()
      .getAll()
      .map((m) => m.meta);
    expect(metas).toHaveLength(2);
    for (const m of metas) expect(m).toEqual({ localErrorToast: true });
  });
});
