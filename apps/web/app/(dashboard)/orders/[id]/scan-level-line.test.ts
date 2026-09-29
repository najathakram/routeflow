import { bumpLineForScan } from "./scan-level-line";

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
