import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PRICE_WRITE_METHOD,
  priceWriteError,
  useSavePrices,
  useUndoPrices,
} from "./usePriceWrites";
import { priceGridKey } from "./usePriceGrid";

const mockPost = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: {
    post: (...a: unknown[]) => mockPost(...a),
    patch: (...a: unknown[]) => mockPost(...a),
  },
}));

const wrap = (qc: QueryClient) =>
  function W({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };

describe("usePriceWrites", () => {
  beforeEach(() => mockPost.mockReset());

  it("saves with the contract path and puts the fresh grid in the cache", async () => {
    const grid = { productId: "p1", anchor: "pack", rows: [] };
    mockPost.mockResolvedValue({
      data: { revision: 8, auditId: "a1", undo: { patches: [], customerMoves: [] }, grid },
    });
    const qc = new QueryClient();
    const { result } = renderHook(() => useSavePrices("p1"), { wrapper: wrap(qc) });
    result.current.mutate({
      expectedRevision: 7,
      expectedPriceState: "ps",
      patches: [{ ref: "pack", tier: 1, to: 2 }],
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(PRICE_WRITE_METHOD).toBe("post");
    expect(mockPost).toHaveBeenCalledWith(
      "/products/p1/prices",
      expect.objectContaining({ expectedRevision: 7 }),
    );
    expect(qc.getQueryData(priceGridKey("p1"))).toBe(grid);
  });

  it("undo posts to the undo path; a stale answer reloads the grid", async () => {
    mockPost.mockRejectedValue({ response: { data: { code: "LADDER_REVISION_STALE" } } });
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useUndoPrices("p1"), { wrapper: wrap(qc) });
    result.current.mutate({ auditId: "a1", expectedRevision: 8, expectedPriceState: "ps" });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(mockPost.mock.calls[0][0]).toBe("/products/p1/prices/undo");
    expect(spy).toHaveBeenCalledWith({ queryKey: priceGridKey("p1") });
  });

  it("maps the contract's errors to words", () => {
    const e = (code: string, problems?: string[]) =>
      priceWriteError({ response: { data: { code, problems } } });
    expect(e("LADDER_REVISION_STALE")?.message).toBe(
      "Prices changed since you opened this; review and save again",
    );
    expect(e("PRICE_EDIT_INVALID", ["x"])?.problems).toEqual(["x"]);
    expect(e("PRICING_RULES_NOT_READY")?.code).toBe("rules");
    expect(e("PRICE_UNDO_UNAVAILABLE")?.code).toBe("unavailable");
    expect(e("FAMILY_PRICE_AUTHORITY")).toMatchObject({
      code: "family",
      message: expect.stringContaining("set on its family"),
    });
    expect(priceWriteError(new Error("boom"))?.code).toBe("other");
    expect(priceWriteError(null)).toBeNull();
  });
});
