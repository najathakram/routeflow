import { renderHook } from "@testing-library/react";
import { usePriceUndo } from "./usePriceUndo";

const stale = Object.assign(new Error("409"), {
  response: { status: 409, data: { code: "LADDER_REVISION_STALE", revision: 9 } },
});
const unavailable = Object.assign(new Error("409"), {
  response: { status: 409, data: { code: "PRICE_UNDO_UNAVAILABLE" } },
});
const PREVIEW = { revision: 9, priceState: "s9", rows: [] };

function setup(over: { current?: { revision: number; priceState: string } } = {}) {
  const mutate = jest.fn();
  const loadPreview = jest.fn().mockResolvedValue(PREVIEW);
  const { result } = renderHook(() =>
    usePriceUndo({
      lastSave: { auditId: "a1", revision: 7 },
      current: over.current ?? { revision: 7, priceState: "s7" },
      mutate,
      loadPreview,
    }),
  );
  return { undo: result.current, mutate, loadPreview };
}

describe("usePriceUndo", () => {
  it("writes the inverse under the current grid's revision and state", async () => {
    const t = setup();
    t.mutate.mockResolvedValue({});
    await expect(t.undo({ confirmed: false })).resolves.toEqual({ status: "undone" });
    expect(t.mutate).toHaveBeenCalledWith({
      auditId: "a1",
      expectedRevision: 7,
      expectedPriceState: "s7",
    });
  });

  it("previews without writing when the grid moved past the save", async () => {
    const t = setup({ current: { revision: 8, priceState: "s8" } });
    await expect(t.undo({ confirmed: false })).resolves.toEqual({ status: "changed", ...PREVIEW });
    expect(t.mutate).not.toHaveBeenCalled();
  });

  it("turns a 409 LADDER_REVISION_STALE into a preview", async () => {
    const t = setup();
    t.mutate.mockRejectedValue(stale);
    await expect(t.undo({ confirmed: false })).resolves.toEqual({ status: "changed", ...PREVIEW });
  });

  it("a confirmed call sends the preview's tokens and re-previews if stale again", async () => {
    const t = setup();
    t.mutate.mockRejectedValue(stale);
    const out = await t.undo({ confirmed: true, expectedRevision: 9, expectedPriceState: "s9" });
    expect(t.mutate).toHaveBeenCalledWith({
      auditId: "a1",
      expectedRevision: 9,
      expectedPriceState: "s9",
    });
    expect(out).toEqual({ status: "changed", ...PREVIEW });
    expect(t.loadPreview).toHaveBeenCalledTimes(1);
  });

  it("maps PRICE_UNDO_UNAVAILABLE and rethrows anything else", async () => {
    const t = setup();
    t.mutate.mockRejectedValueOnce(unavailable);
    await expect(t.undo({ confirmed: false })).resolves.toEqual({ status: "unavailable" });
    t.mutate.mockRejectedValueOnce(new Error("network"));
    await expect(t.undo({ confirmed: false })).rejects.toThrow("network");
  });
});
