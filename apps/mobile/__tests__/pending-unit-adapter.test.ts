import type { LineState } from "../lib/cart-line-state";
import {
  anyLineLoading,
  applyAddToItems,
  editItemLine,
  refusedScanOutcome,
  settleBeforeConfirm,
  UNITS_BLOCKED_MESSAGE,
} from "../lib/pending-unit-adapter";
import { UNITS_LOADING_SCAN_MESSAGE } from "../lib/default-unit-line";
import { showToast } from "../lib/toast";

jest.mock("../lib/toast", () => ({ showToast: jest.fn() }));

/**
 * #2865: the order screen's pending-unit logic lives in lib/pending-unit-adapter (the screen holds only call sites), so the
 * behaviour is pinned HERE, not by reading the screen's source.
 */
type Items = Record<string, LineState>;
const pendingLine = (over: Partial<LineState> = {}): LineState => ({
  qty: 12,
  boxes: 1,
  pieces: 0,
  startOnDefaultUnit: 12,
  pendingTaps: 1,
  pendingCode: "012345678905",
  ...over,
});
const base = { id: "p1", level: "BOX" as const, role: "OPERATOR", upb: 12, prefill: undefined };

beforeEach(() => (showToast as jest.Mock).mockClear());

describe("refusedScanOutcome: EXACTLY ONE message, in the layer the operator can see (F4)", () => {
  it("sheet OPEN -> the sheet's own error pill and NO app toast", () => {
    expect(refusedScanOutcome(true)).toEqual({
      feedback: { kind: "error", text: UNITS_LOADING_SCAN_MESSAGE },
    });
    expect(showToast).not.toHaveBeenCalled();
  });

  it("sheet CLOSED -> the app toast (once) and NO pill", () => {
    expect(refusedScanOutcome(false)).toBeUndefined();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(UNITS_LOADING_SCAN_MESSAGE);
  });
});

describe("applyAddToItems (the add decision)", () => {
  it("a default scan creates a PENDING line (1 tap, the creating code recorded); repeats of that code are taps even with dflt false (3 -> 3)", () => {
    const code = "012345678905";
    const one = applyAddToItems({}, { ...base, dflt: true, code });
    expect(one.p1).toMatchObject({
      pendingTaps: 1,
      pendingCode: code,
      startOnDefaultUnit: one.p1.qty,
    });
    const three = [1, 2].reduce((acc) => applyAddToItems(acc, { ...base, dflt: false, code }), one);
    expect(three.p1.pendingTaps).toBe(3);
    expect(three.p1.qty).toBe(one.p1.qty); // the line's own quantity never moves while pending
  });

  it("a DIFFERENT code, or the row '+', on a pending line is refused: the SAME object back", () => {
    const one = applyAddToItems({}, { ...base, dflt: true, code: "012345678905" });
    expect(applyAddToItems(one, { ...base, dflt: false, code: "999999999994" })).toBe(one);
    expect(applyAddToItems(one, { ...base, dflt: true, viaRow: true })).toBe(one);
  });

  it("a settled line takes a scan as it always did; a remembered price pre-fills a NEW line only (history)", () => {
    const settled: Items = { p1: { qty: 12, boxes: 1, pieces: 0 } };
    expect(applyAddToItems(settled, { ...base, dflt: false })).not.toBe(settled);
    expect(applyAddToItems({}, { ...base, dflt: true, prefill: 2.5 }).p1).toMatchObject({
      unitPrice: 2.5,
      priceSource: "history",
    });
  });
});

describe("editItemLine (every qty handler)", () => {
  it("is REFUSED on a pending line (the same object back) for every intent", () => {
    const items: Items = { p1: pendingLine() };
    for (const intent of ["qty", "unit", "increment"] as const) {
      expect(editItemLine(items, "p1", intent, (l) => ({ ...l, qty: 99 }))).toBe(items);
    }
  });

  it("edits a settled line, and a null result removes it", () => {
    const items: Items = { p1: { qty: 2 } };
    expect(editItemLine(items, "p1", "qty", (l) => ({ ...l, qty: 5 })).p1.qty).toBe(5);
    expect(editItemLine(items, "p1", "qty", () => null)).toEqual({});
  });
});

describe("settleBeforeConfirm (Confirm's gate)", () => {
  const resolved =
    (items: Items, blocked: string[] = []) =>
    async () => ({ items, blocked });

  it("blocked: the ladder could not load -> no submit", async () => {
    const items: Items = { p1: pendingLine() };
    expect(await settleBeforeConfirm(items, resolved(items, ["p1"]))).toEqual({ kind: "blocked" });
    expect(UNITS_BLOCKED_MESSAGE).toMatch(/Couldn't load the selling units/);
  });

  it("stop: this press RESOLVED a pending line (the retry) -> the settled line is shown, a second press submits", async () => {
    const items: Items = { p1: pendingLine() };
    const lines: Items = { p1: { qty: 3, unitLabel: "Bottle" } };
    expect(await settleBeforeConfirm(items, resolved(lines))).toEqual({ kind: "stop", lines });
  });

  it("ready: nothing was pending -> submit the lines", async () => {
    const items: Items = { p1: { qty: 2 } };
    expect(await settleBeforeConfirm(items, resolved(items))).toEqual({
      kind: "ready",
      lines: items,
    });
  });
});

describe("anyLineLoading (Confirm disabled only while LOADING)", () => {
  it("true only for a loading line; a failed line stays pressable", () => {
    const items: Items = { a: pendingLine(), b: pendingLine() };
    expect(anyLineLoading(items, (id) => (id === "a" ? "loading" : "failed"))).toBe(true);
    expect(anyLineLoading(items, () => "failed")).toBe(false);
    expect(anyLineLoading(items, () => undefined)).toBe(false);
  });
});
