/**
 * #2717 M4a-1 (SA-580): the pure line math for a scan that lands one BOX or one UNIT.
 * RED (M4a-1): `newLineQtyForLevel` and `mergePieceIntoLine` are not exported by add-line-merge.ts yet
 * (TypeError: ... is not a function).
 */
import { normalizeBoxesPieces } from "@routeflow/pricing";
import * as m from "./add-line-merge";

const { newLineQty, mergeQtyIntoLine } = m;
const newLineQtyForLevel = (m as any).newLineQtyForLevel as (
  upb: number | undefined,
  level: "BOX" | "UNIT",
  n: number,
) => { qty: number; boxes?: number; pieces?: number };
const mergePieceIntoLine = (m as any).mergePieceIntoLine as <T extends object>(
  line: T,
  n: number,
) => T;

describe("newLineQtyForLevel", () => {
  it("UNIT on a boxed product -> one loose piece, no hidden box: {qty:1, boxes:0, pieces:1}", () => {
    expect(newLineQtyForLevel(12, "UNIT", 1)).toEqual({ qty: 1, boxes: 0, pieces: 1 });
  });

  it("BOX on a boxed product -> today's first add: one whole case", () => {
    expect(newLineQtyForLevel(12, "BOX", 1)).toEqual(newLineQty(12, 1));
    expect(newLineQtyForLevel(12, "BOX", 1)).toEqual({ qty: 12, boxes: 1, pieces: 0 });
  });

  it("R4: upb undefined or 1 -> today's line shape for BOTH levels (parity pinned on the outcome, not the level)", () => {
    for (const upb of [undefined, 1]) {
      for (const level of ["BOX", "UNIT"] as const) {
        expect(newLineQtyForLevel(upb, level, 1)).toEqual(newLineQty(upb, 1));
      }
    }
  });
});

describe("mergePieceIntoLine — one loose piece onto the ONE existing line", () => {
  const line = (boxes: number, pieces: number, upb = 12) => ({
    qty: boxes * upb + pieces,
    boxes,
    pieces,
    unitsPerBox: upb,
  });

  it("1 case + 0 loose -> 1 case + 1 loose, qty 13 (the line shows boxes AND pieces)", () => {
    expect(mergePieceIntoLine(line(1, 0), 1)).toMatchObject({ boxes: 1, pieces: 1, qty: 13 });
  });

  it("rolls over through normalizeBoxesPieces: 1 case + 11 loose + 1 piece -> 2 cases + 0 loose", () => {
    const out: any = mergePieceIntoLine(line(1, 11), 1);
    expect(out).toMatchObject({ boxes: 2, pieces: 0, qty: 24 });
    expect(normalizeBoxesPieces({ qty: out.qty, unitsPerBox: 12 })).toMatchObject({
      boxes: 2,
      pieces: 0,
    });
  });

  it("a non-boxed line just gains qty + 1 (R4)", () => {
    expect(mergePieceIntoLine({ qty: 3 }, 1)).toEqual({ qty: 4 });
  });

  it("a BOX scan onto the same line is today's mergeQtyIntoLine (box -> box merge unchanged)", () => {
    expect(mergeQtyIntoLine(line(1, 3), 1)).toMatchObject({ boxes: 2, pieces: 3, qty: 27 });
  });
});
