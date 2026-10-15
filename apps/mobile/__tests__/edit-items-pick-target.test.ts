/**
 * SA-595 follow-up (review item 1): a scan that resolves to UNIT on an upb<=1 product (a shared
 * code, SA-580b) must behave like a picker tap in the order editor: no keying onto a unit-label
 * line and no "Add 1 <label>?" confirm. Only a UNIT scan on a BOXED product (upb>1) keeps that.
 */
import { resolvePickTarget } from "../lib/edit-items-draft";

const unitLine = { productId: "p1", unitLabel: "Case", qty: 2, unitsPerBox: 1 } as any;
const plainLine = { productId: "p1", qty: 1, unitsPerBox: 1 } as any;
const base = { productId: "p1", name: "Sample", startPrice: 5, catalogPrice: 5 };

describe("resolvePickTarget — the unit-label guard needs upb > 1 (SA-580b)", () => {
  it("UNIT on upb 1 with a unit-label line: no existingLabel, keyed like a picker tap", () => {
    const draft = { U1: unitLine, P1: plainLine };
    const scan = resolvePickTarget(draft, { ...base, unitsPerBox: 1, level: "UNIT" });
    const tap = resolvePickTarget(draft, { ...base, unitsPerBox: 1, level: "BOX" });
    expect(scan.existingLabel).toBeUndefined();
    expect(scan.key).toBe(tap.key);
    expect(scan.key).not.toBe("U1");
  });

  it("UNIT on upb null behaves the same (no unit-label keying)", () => {
    const r = resolvePickTarget({ U1: unitLine }, { ...base, unitsPerBox: null, level: "UNIT" });
    expect(r.existingLabel).toBeUndefined();
    expect(r.key).not.toBe("U1");
  });

  it("UNIT on a boxed product (upb 6) still keys onto the unit-label line and asks", () => {
    const r = resolvePickTarget({ U1: unitLine }, { ...base, unitsPerBox: 6, level: "UNIT" });
    expect(r.existingLabel).toBe("Case");
    expect(r.key).toBe("U1");
  });
});

describe("a FAMILY container is never added to an order edit", () => {
  it("applyPickToDraft returns the draft untouched for a FAMILY", () => {
    const draft = {};
    const r = resolvePickTarget(draft, { ...base, unitsPerBox: 1, level: "BOX", kind: "FAMILY" });
    expect(r.apply(draft)).toBe(draft);
  });
  it("a variant still adds", () => {
    const r = resolvePickTarget({}, { ...base, unitsPerBox: 1, level: "BOX", kind: "VARIANT" });
    expect(Object.keys(r.apply({}))).toHaveLength(1);
  });
});
