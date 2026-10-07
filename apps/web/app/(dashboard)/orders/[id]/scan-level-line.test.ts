import { bumpLineForScan, explicitBumpLevel, splitLineHintText } from "./scan-level-line";

// Review item 4 (#2764): a picker TAP (no explicit level) keeps the OLD +1 on a boxSplit line;
// only an explicit scan level BOX adds a whole case (+upb pieces).
const split = { qty: 13, unitsPerBox: 12, unitLabel: null, boxSplit: true };

describe("bumpLineForScan — picker tap vs explicit scan level on a boxSplit line", () => {
  it("picker tap (no level) on a boxSplit line: +1 (the old behaviour)", () => {
    expect(bumpLineForScan(split, false).qty).toBe(14);
  });
  it("explicit BOX scan on a boxSplit line: +upb pieces (a whole case)", () => {
    expect(bumpLineForScan(split, false, "BOX").qty).toBe(25);
  });
  it("explicit UNIT scan on a boxSplit line: +1 piece", () => {
    expect(bumpLineForScan(split, true, "UNIT").qty).toBe(14);
  });
  it("plain boxed line: tap and BOX scan both +1 case; UNIT scan switches to split", () => {
    const plain = { qty: 2, unitsPerBox: 12, unitLabel: null };
    expect(bumpLineForScan(plain, false).qty).toBe(3);
    expect(bumpLineForScan(plain, false, "BOX").qty).toBe(3);
    expect(bumpLineForScan(plain, true, "UNIT")).toMatchObject({ qty: 25, boxSplit: true });
  });
});

// SA-580c: a SHARED code (levels BOX+UNIT) is a picker tap; only a DISTINCT BOX code is explicit.
describe("explicitBumpLevel + bumpLineForScan — shared code equals a picker tap", () => {
  const legacy = { barcode: "111", sku: null, unitSku: null, unitsPerBox: 12 };
  it("shared legacy barcode (upb 12) on a boxSplit line adds +1 like a tap (13 -> 14)", () => {
    const lvl = explicitBumpLevel("111", legacy);
    expect(lvl).toBeUndefined();
    expect(bumpLineForScan(split, false, lvl).qty).toBe(14);
  });
  it("distinct BOX code (sku) adds a whole case (13 -> 25)", () => {
    const p = { barcode: null, sku: "CASE1", unitSku: null, unitsPerBox: 12 };
    const lvl = explicitBumpLevel("CASE1", p);
    expect(lvl).toBe("BOX");
    expect(bumpLineForScan(split, false, lvl).qty).toBe(25);
  });
  it("distinct UNIT code (unitSku) keeps the UNIT behaviour (+1 piece)", () => {
    const p = { barcode: null, sku: "CASE1", unitSku: "PC1", unitsPerBox: 12 };
    expect(explicitBumpLevel("PC1", p)).toBeUndefined();
    expect(bumpLineForScan(split, true, "UNIT").qty).toBe(14);
  });
});

describe("splitLineHintText — singular/plural (Opus nit, #2764)", () => {
  it("1 box (not '1 boxes'), plural otherwise, pcs stays a count", () => {
    expect(splitLineHintText(12, 12)).toBe("1 box + 0 pcs");
    expect(splitLineHintText(25, 12)).toBe("2 boxes + 1 pcs");
    expect(splitLineHintText(5, 12)).toBe("0 boxes + 5 pcs");
  });
});
