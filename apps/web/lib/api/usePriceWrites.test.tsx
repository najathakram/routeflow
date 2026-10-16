import * as React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import {
  PRICE_WRITE_METHOD,
  priceWriteError,
  useSavePrices,
  useUndoPrices,
} from "./usePriceWrites";
import { priceGridKey } from "./usePriceGrid";
import { queryClientWithGlobalErrorToast, refusal } from "@/test-utils/global-error-toast";

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

  it("a stale save does not refetch the grid", async () => {
    mockPost.mockRejectedValue({ response: { data: { code: "LADDER_REVISION_STALE" } } });
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useSavePrices("p1"), { wrapper: wrap(qc) });
    result.current.mutate({ expectedRevision: 7, expectedPriceState: "ps", patches: [] });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(priceWriteError(result.current.error)?.code).toBe("stale");
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps the contract's errors to words", () => {
    const e = (code: string, problems?: string[]) =>
      priceWriteError({ response: { data: { code, problems } } });
    expect(e("LADDER_REVISION_STALE")?.copy).toBe(
      "Prices changed since you opened this; review and save again",
    );
    expect(e("PRICE_EDIT_INVALID", ["x"])?.problems).toEqual(["x"]);
    expect(e("PRICING_RULES_NOT_READY")?.code).toBe("rules");
    expect(e("PRICE_UNDO_UNAVAILABLE")?.code).toBe("unavailable");
    expect(e("FAMILY_PRICE_AUTHORITY")).toMatchObject({
      code: "family",
      copy: expect.stringContaining("set on its family"),
    });
    expect(priceWriteError(new Error("boom"))?.code).toBe("other");
    expect(priceWriteError(null)).toBeNull();
  });

  it("B986: an unknown code (or no code) maps to the generic copy; a raw server message never becomes copy", () => {
    const GENERIC = "Couldn't save prices. Try again.";
    const raw = "SQL boom secret";
    const unknown = priceWriteError({
      response: { data: { code: "SOMETHING_NEW", message: raw, problems: [raw] } },
    });
    expect(unknown).toEqual({ code: "other", copy: GENERIC, problems: [] });
    expect(JSON.stringify(unknown)).not.toContain(raw);
    expect(priceWriteError({ response: { data: { message: raw } } })?.copy).toBe(GENERIC);
    expect(priceWriteError(new Error(raw))?.copy).toBe(GENERIC);
    expect(JSON.stringify(priceWriteError(new Error(raw)))).not.toContain(raw);
  });

  it("NIT-2: a code that is an Object.prototype name is an unknown code, not a table hit", () => {
    const GENERIC = "Couldn't save prices. Try again.";
    for (const code of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(priceWriteError({ response: { data: { code, problems: ["x"] } } })).toEqual({
        code: "other",
        copy: GENERIC,
        problems: [],
      });
    }
  });

  describe("M4: the page owns the error UI, so the app-wide toast stays quiet", () => {
    const SAVE = { expectedRevision: 7, expectedPriceState: "ps", patches: [] };
    const stale = () => refusal(409, { code: "LADDER_REVISION_STALE" });

    it("a stale save raises no global toast (the edit bar's notice is the one message)", async () => {
      mockPost.mockRejectedValue(stale());
      const toast = jest.fn();
      const qc = queryClientWithGlobalErrorToast(toast);
      const { result } = renderHook(() => useSavePrices("p1"), { wrapper: wrap(qc) });
      result.current.mutate(SAVE);
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(toast).not.toHaveBeenCalled();
    });

    it("an unmapped save failure raises no global toast either (the bar says the generic copy)", async () => {
      mockPost.mockRejectedValue(refusal(500, { message: "SQL boom secret" }));
      const toast = jest.fn();
      const qc = queryClientWithGlobalErrorToast(toast);
      const { result } = renderHook(() => useSavePrices("p1"), { wrapper: wrap(qc) });
      result.current.mutate(SAVE);
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(toast).not.toHaveBeenCalled();
    });

    it("a failed undo raises no global toast (the status line says Couldn't undo)", async () => {
      mockPost.mockRejectedValue(refusal(500, { message: "boom" }));
      const toast = jest.fn();
      const qc = queryClientWithGlobalErrorToast(toast);
      const { result } = renderHook(() => useUndoPrices("p1"), { wrapper: wrap(qc) });
      result.current.mutate({ auditId: "a1", expectedRevision: 8, expectedPriceState: "ps" });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(toast).not.toHaveBeenCalled();
    });

    it("control: a mutation without the meta still gets the global toast", async () => {
      const toast = jest.fn();
      const qc = queryClientWithGlobalErrorToast(toast);
      const { result } = renderHook(
        () => useMutation({ mutationFn: () => Promise.reject(refusal(500, { message: "boom" })) }),
        { wrapper: wrap(qc) },
      );
      result.current.mutate();
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(toast).toHaveBeenCalledTimes(1);
    });
  });
});
