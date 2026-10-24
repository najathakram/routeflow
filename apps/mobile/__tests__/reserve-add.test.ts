import { readFileSync } from "fs";
import { join } from "path";
import type { LineState } from "../lib/cart-line-state";
import { reserveAdd } from "../lib/pending-unit-adapter";

jest.mock("../lib/toast", () => ({ showToast: jest.fn() }));

/**
 * B992: addOne decides refuse/accept from a ref of the latest lines, and the ref used to move only at the next RENDER. Two
 * adds in the SAME render (a scan engine draining its queue) both read the stale ref: a refusal the first one's result
 * implies was missed, the updater then refused it silently, and the caller still counted/toasted "Added". `reserveAdd`
 * moves the ref forward itself, so the second add is decided on the first one's result and a refusal is reported exactly.
 */
type Items = Record<string, LineState>;
const base = { id: "p1", level: "BOX" as const, role: "OPERATOR", upb: 12, prefill: undefined };
const ref = (items: Items = {}) => ({ current: items });

describe("reserveAdd (same-render adds are decided in sequence)", () => {
  it("the first scan creates the pending line; a DIFFERENT code in the SAME render is refused (false), the ref still holds the first line", () => {
    const r = ref();
    expect(reserveAdd(r, { ...base, dflt: true, code: "012345678905" })).toBe(true);
    const afterFirst = r.current;
    expect(afterFirst.p1.pendingTaps).toBe(1);
    expect(reserveAdd(r, { ...base, dflt: false, code: "999999999994" })).toBe(false); // would have been silent before
    expect(r.current).toBe(afterFirst);
  });

  it("the row '+' right after the creating scan (same render) is refused", () => {
    const r = ref();
    reserveAdd(r, { ...base, dflt: true, code: "012345678905" });
    expect(reserveAdd(r, { ...base, dflt: true, viaRow: true })).toBe(false);
  });

  it("repeats of the creating code in the same render are taps: 3 scans -> 3 taps, all accepted", () => {
    const r = ref();
    const code = "012345678905";
    expect(reserveAdd(r, { ...base, dflt: true, code })).toBe(true);
    expect(reserveAdd(r, { ...base, dflt: false, code })).toBe(true);
    expect(reserveAdd(r, { ...base, dflt: false, code })).toBe(true);
    expect(r.current.p1.pendingTaps).toBe(3);
  });

  it("a settled line takes a scan (true) and the ref moves", () => {
    const r = ref({ p1: { qty: 12, boxes: 1, pieces: 0 } });
    expect(reserveAdd(r, { ...base, dflt: false })).toBe(true);
    expect(r.current.p1.qty).toBeGreaterThan(12);
  });
});

describe("wiring: addOne reserves through reserveAdd, then re-applies on the true latest state", () => {
  it("the screen calls reserveAdd(itemsRef, input) and returns false on a refusal", () => {
    const src = readFileSync(join(__dirname, "..", "components", "NewOrderScreen.tsx"), "utf8");
    expect(src).toMatch(/if \(!reserveAdd\(itemsRef, input\)\) return false;/);
    expect(src).toMatch(/setItems\(\(m\) => applyAddToItems\(m, input\)\)/);
    expect(src).not.toMatch(/applyAddToItems\(itemsRef\.current, input\) === itemsRef\.current/);
  });
});
