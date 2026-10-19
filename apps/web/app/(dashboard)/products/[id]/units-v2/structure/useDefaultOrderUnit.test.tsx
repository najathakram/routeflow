import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ProductUnitLevel } from "@routeflow/types";
import { createTestQueryClient } from "@/test-utils/render";
import { useDefaultOrderUnit } from "./useDefaultOrderUnit";

const updateMutate = jest.fn();
jest.mock("@/lib/api/product-units", () => ({
  useUpdateProductUnit: () => ({ mutate: updateMutate, isPending: false }),
}));

const unit = (id: string, label: string, isDefaultSelling = false) =>
  ({ id, label, factorToBase: 12, isDefaultSelling }) as unknown as ProductUnitLevel;
const caseU = unit("u-case", "Case");
const pallet = unit("u-pallet", "Pallet");
const palletDefault = unit("u-pallet", "Pallet", true);

const wrap = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
);
const setup = (units: ProductUnitLevel[]) =>
  renderHook(({ u }) => useDefaultOrderUnit("p1", u, "Box"), {
    wrapper: wrap,
    initialProps: { u: units },
  });

beforeEach(() => {
  jest.resetAllMocks();
  updateMutate.mockImplementation((_b, o) => o?.onSuccess?.({}));
});

describe("useDefaultOrderUnit", () => {
  it("making a unit the default sets it and says so, with an Undo that restores the pack", () => {
    const { result } = setup([caseU, pallet]);
    act(() => result.current.change(pallet));
    expect(updateMutate).toHaveBeenLastCalledWith(
      { id: "u-pallet", isDefaultSelling: true },
      expect.any(Object),
    );
    expect(result.current.note?.text).toBe("Pallet is now the default order unit.");
    act(() => result.current.undo());
    expect(updateMutate).toHaveBeenLastCalledWith(
      { id: "u-pallet", isDefaultSelling: false },
      expect.any(Object),
    );
    expect(result.current.note?.text).toBe("Box is the default order unit again.");
  });

  it("choosing the pack (null) unsets the previous default; choosing the current default writes nothing", () => {
    const { result } = setup([caseU, palletDefault]);
    act(() => result.current.change(palletDefault));
    expect(updateMutate).not.toHaveBeenCalled();
    act(() => result.current.change(null));
    expect(updateMutate).toHaveBeenLastCalledWith(
      { id: "u-pallet", isDefaultSelling: false },
      expect.any(Object),
    );
    expect(result.current.note?.text).toBe("Box is now the default order unit.");
  });

  it("does nothing while busy, and the note goes when the default changes under it", () => {
    const busy = renderHook(() => useDefaultOrderUnit("p1", [caseU], "Box", { busy: true }), {
      wrapper: wrap,
    });
    act(() => busy.result.current.change(caseU));
    expect(updateMutate).not.toHaveBeenCalled();

    const { result, rerender } = setup([caseU, pallet]);
    act(() => result.current.change(pallet));
    expect(result.current.note).not.toBeNull();
    rerender({ u: [caseU, palletDefault] }); // our own write's refetch: the note stays
    expect(result.current.note).not.toBeNull();
    rerender({ u: [unit("u-case", "Case", true), pallet] }); // changed elsewhere: the note is untrue
    expect(result.current.note).toBeNull();
  });
});
