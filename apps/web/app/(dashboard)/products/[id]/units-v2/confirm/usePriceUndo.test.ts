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
      conflictRow: (c) => ({
        ref: `${c.customerId}|${c.ref}`,
        label: `${c.customerId}, ${c.ref}`,
        current: String(c.current),
        restoreTo: String(c.expected),
      }),
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

describe("usePriceUndo: strict undo conflicts and skip", () => {
  const conflict = {
    customerId: "c1",
    ref: "can",
    tier: 2,
    expected: 1.13,
    current: 1.2,
  };
  const stale409 = Object.assign(new Error("409"), {
    response: {
      status: 409,
      data: { code: "LADDER_REVISION_STALE", revision: 9, conflicts: [conflict] },
    },
  });

  it("a 409 with `conflicts` previews them next to the fresh tokens; each carries its skip entry", async () => {
    const t = setup();
    t.mutate.mockRejectedValue(stale409);
    const out = await t.undo({ confirmed: false });
    expect(out).toEqual({
      status: "changed",
      ...PREVIEW,
      conflicts: [
        {
          row: { ref: "c1|can", label: "c1, can", current: "1.2", restoreTo: "1.13" },
          skip: { customerId: "c1", ref: "can", seen: 1.2 },
        },
      ],
    });
  });

  it("a confirmed skip sends the skip list with the fresh tokens and reports how many were kept", async () => {
    const t = setup();
    t.mutate.mockResolvedValue({
      skipped: [{ customerId: "c1", ref: "can", tier: 2, current: 1.2 }],
    });
    const out = await t.undo({
      confirmed: true,
      expectedRevision: 9,
      expectedPriceState: "s9",
      skip: [{ customerId: "c1", ref: "can", seen: 1.2 }],
    });
    expect(t.mutate).toHaveBeenCalledWith({
      auditId: "a1",
      expectedRevision: 9,
      expectedPriceState: "s9",
      skip: [{ customerId: "c1", ref: "can", seen: 1.2 }],
    });
    expect(out).toEqual({ status: "undone", skipped: 1 });
  });
});
