/** B1220 — what a screen does with a resolve result; nothing is committed until the user confirms. */
import { decideScanResult, runScanDecision } from "../lib/scan-suggestion";

const p = { id: "p1", name: "Blue Widget" };
const sugg: any = { product: p, source: "search", ambiguous: true, suggestion: true, matches: [p] };

describe("decideScanResult", () => {
  it("plain hit -> add", () => {
    expect(decideScanResult({ product: p, source: "sku" } as any, "add")).toEqual({
      kind: "add",
      product: p,
    });
  });
  it("suggestion -> confirm with the product name and Add verb", () => {
    const d: any = decideScanResult(sugg, "add");
    expect(d.kind).toBe("confirm-suggestion");
    expect(d.message).toContain("Did you mean Blue Widget?");
    expect(d.confirmText).toBe("Add");
  });
  it("suggestion on a stock-writing screen -> Apply verb", () => {
    const d: any = decideScanResult(sugg, "stock");
    expect(d.confirmText).toBe("Apply");
  });
  it("several fuzzy -> pick-from-list", () => {
    const q = { id: "p2", name: "Other" };
    const d: any = decideScanResult(
      { product: p, source: "search", ambiguous: true, matches: [p, q] } as any,
      "add",
    );
    expect(d).toEqual({ kind: "pick-from-list", matches: [p, q], confirmText: "Add" });
  });
  it("notFound -> not-found", () => {
    expect(decideScanResult({ notFound: true }, "add")).toEqual({ kind: "not-found" });
  });
});

describe("runScanDecision", () => {
  it("confirm adds exactly once; cancel adds nothing", () => {
    const d = decideScanResult(sugg, "add");
    const onCommit = jest.fn();
    let confirmCb: (() => void) | undefined;
    const confirmFn = jest.fn((_t: string, _m: string, cb: () => void) => {
      confirmCb = cb;
    });
    runScanDecision(d, onCommit, confirmFn as any);
    expect(onCommit).not.toHaveBeenCalled();
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect((confirmFn.mock.calls[0] as any[])[3]).toMatchObject({ confirmText: "Add" });
    confirmCb!();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(p);
  });
  it("cancel never invokes the commit callback", () => {
    const onCommit = jest.fn();
    runScanDecision(decideScanResult(sugg, "add"), onCommit, jest.fn() as any);
    expect(onCommit).not.toHaveBeenCalled();
  });
  it("a plain add commits immediately", () => {
    const onCommit = jest.fn();
    runScanDecision(
      decideScanResult({ product: p, source: "sku" } as any, "add"),
      onCommit,
      jest.fn() as any,
    );
    expect(onCommit).toHaveBeenCalledWith(p);
  });
});

describe("runScanDecision — 2+ fuzzy matches (B1220)", () => {
  const q = { id: "p2", name: "Other" };
  const two: any = { product: p, source: "search", ambiguous: true, matches: [p, q] };

  it("commits nothing until a row is chosen; the picker gets EVERY match", () => {
    const onCommit = jest.fn();
    const confirmFn = jest.fn();
    let chosen: ((x: any) => void) | undefined;
    const pick = jest.fn((_m: any[], _c: string, commit: (x: any) => void) => {
      chosen = commit;
    });
    const handled = runScanDecision(decideScanResult(two, "add"), onCommit, confirmFn as any, {
      pick,
    });
    expect(handled).toBe(true);
    expect(onCommit).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
    expect(pick.mock.calls[0][0]).toEqual([p, q]);
    expect(pick.mock.calls[0][1]).toBe("Add");
    chosen!(q);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(q);
  });

  it("stock screens get the Apply verb", () => {
    const pick = jest.fn();
    runScanDecision(decideScanResult(two, "stock"), jest.fn(), jest.fn() as any, { pick });
    expect(pick.mock.calls[0][1]).toBe("Apply");
  });

  it("cancel commits nothing and clears the prompt flag", () => {
    const onCommit = jest.fn();
    const flag = jest.fn();
    let cancel: (() => void) | undefined;
    const pick = jest.fn((_m: any[], _c: string, _commit: any, onCancel: () => void) => {
      cancel = onCancel;
    });
    runScanDecision(decideScanResult(two, "add"), onCommit, jest.fn() as any, {
      pick,
      onPromptChange: flag,
    });
    expect(flag).toHaveBeenLastCalledWith(true);
    cancel!();
    expect(flag).toHaveBeenLastCalledWith(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("without a pick handler it is NOT handled and commits nothing", () => {
    const onCommit = jest.fn();
    expect(runScanDecision(decideScanResult(two, "add"), onCommit, jest.fn() as any)).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a suggestion confirm reports prompt open, then closed on cancel", () => {
    const flag = jest.fn();
    let onCancel: (() => void) | undefined;
    const confirmFn = jest.fn((_t: string, _m: string, _cb: () => void, o: any) => {
      onCancel = o.onCancel;
    });
    runScanDecision(decideScanResult(sugg, "add"), jest.fn(), confirmFn as any, {
      onPromptChange: flag,
    });
    expect(flag).toHaveBeenLastCalledWith(true);
    onCancel!();
    expect(flag).toHaveBeenLastCalledWith(false);
  });
});
