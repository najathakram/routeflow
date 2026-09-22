import { regulatedUnitBasis } from "./regulated-unit-basis";

describe("regulatedUnitBasis", () => {
  it("(1) a unitLabel line: qty is already the base unit, packAtSale ignored", () => {
    expect(regulatedUnitBasis({ qty: 60, unitLabel: "case" }, 12)).toEqual({ unitBasisQty: 60 });
    expect(regulatedUnitBasis({ qty: 60, unitLabel: "case" }, null)).toEqual({ unitBasisQty: 60 });
  });

  it("(2) a box-split line (boxes set): qty is already pieces — 5 boxes of 12 books 60, never 720", () => {
    expect(regulatedUnitBasis({ qty: 60, boxes: 5, pieces: 0 }, 12)).toEqual({ unitBasisQty: 60 });
  });

  it("(2) a box-split line (pieces set, boxes null): qty is already pieces", () => {
    expect(regulatedUnitBasis({ qty: 3, boxes: null, pieces: 3 }, 12)).toEqual({
      unitBasisQty: 3,
    });
  });

  it("(3) no split, no unitLabel, packAtSale <= 1: a non-boxed line books qty unchanged", () => {
    expect(regulatedUnitBasis({ qty: 7, boxes: null, pieces: null }, 1)).toEqual({
      unitBasisQty: 7,
    });
    expect(regulatedUnitBasis({ qty: 7, boxes: null, pieces: null }, null)).toEqual({
      unitBasisQty: 7,
    });
    expect(regulatedUnitBasis({ qty: 7, boxes: null, pieces: null }, undefined)).toEqual({
      unitBasisQty: 7,
    });
  });

  it("(4) box-unaware: no split, no unitLabel, packAtSale > 1 expands by the pack and warns", () => {
    const res = regulatedUnitBasis({ qty: 5, boxes: null, pieces: null }, 12);
    expect(res.unitBasisQty).toBe(60);
    expect(res.warn).toMatch(/B644/);
  });

  it("branch order: unitLabel wins over a split, and a split wins over packAtSale", () => {
    expect(regulatedUnitBasis({ qty: 9, unitLabel: "each", boxes: 3 }, 12)).toEqual({
      unitBasisQty: 9,
    });
    expect(regulatedUnitBasis({ qty: 6, boxes: 6, pieces: 0 }, 12).warn).toBeUndefined();
  });
});
