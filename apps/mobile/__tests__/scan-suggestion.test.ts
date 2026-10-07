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
    expect(d).toEqual({ kind: "pick-from-list", matches: [p, q] });
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
    expect((confirmFn.mock.calls[0] as any[])[3]).toEqual({ confirmText: "Add" });
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
