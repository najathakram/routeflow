/**
 * F30 · REG-B194 — boxed increment must FOLD an existing plain qty, never
 * discard it.
 *
 * The catalog-row qty editor writes a plain `qty` (no boxes/pieces) even for a
 * boxed product (`setLineQty` clears boxes/pieces — see sale-line.ts). Today,
 * `incrementLine`/`incrementLinePiece`'s boxed branches recompute
 * `qty = boxes*upb + pieces` from scratch, so a line holding a typed plain qty
 * of 10 becomes exactly "1 box" (= unitsPerBox) on the next scan — the typed
 * 10 is silently destroyed (sale-line.ts:25,48; NewOrderScreen.tsx:1347-1350).
 *
 * Fix (R4): fold the previously-typed plain qty in as loose pieces and
 * renormalize through the shared `normalizeBoxesPieces` rollover — the same
 * oracle the money-discipline convention already uses everywhere else.
 */
import {
  decrementLine,
  incrementLine,
  incrementLinePiece,
  setLineBoxes,
  setLinePieces,
} from "../lib/sale-line";
import { normalizeBoxesPieces } from "@routeflow/pricing";

describe("sale-line boxed increment folds a typed plain qty (T-B194 / REG-B194)", () => {
  it("incrementLine folds prev.qty as loose pieces before adding the box, instead of discarding it", () => {
    // Operator typed 10 on a boxed product's catalog row (no boxes/pieces set
    // yet — the plain-qty editor path), then scanned the case once.
    const prev = { qty: 10 };
    const unitsPerBox = 24;

    const result = incrementLine(prev, /* isBoxed */ true, unitsPerBox);

    // The plan's oracle: normalize (typed 10) + (1 box worth = unitsPerBox)
    // through the shared rollover — never just "1 box" (qty 24, discarding
    // the 10).
    const expected = normalizeBoxesPieces({ qty: 10 + unitsPerBox, unitsPerBox });

    expect(result.qty).toBe(expected.qty); // 34, not 24
    expect(result.boxes).toBe(expected.boxes); // 1
    expect(result.pieces).toBe(expected.pieces); // 10 — the typed qty survives as loose pieces
  });

  it("incrementLinePiece (piece-code scan) also folds prev.qty and rolls over at unitsPerBox — REG-B194", () => {
    // Same root cause, sibling function (card cites sale-line.ts:17-49 for
    // both incrementLine and incrementLinePiece). Typed 5, unitsPerBox 6,
    // then one loose-piece scan should roll the typed 5 + 1 into a full case.
    const prev = { qty: 5 };
    const unitsPerBox = 6;

    const result = incrementLinePiece(prev, /* isBoxed */ true, unitsPerBox);

    const expected = normalizeBoxesPieces({ qty: 5 + 1, unitsPerBox });

    expect(result.qty).toBe(expected.qty); // 6
    expect(result.boxes).toBe(expected.boxes); // 1 (rolled over, not discarded)
    expect(result.pieces).toBe(expected.pieces); // 0
  });
});

describe("the other boxed branches fold the same typed plain qty (REG-B194)", () => {
  it("decrementLine takes ONE case off a typed plain qty instead of deleting the line", () => {
    // Typed 30 on a 24-pack: one case comes off, the remaining 6 stay loose.
    // The isolated form clamped boxes to 0, read pieces as 0 and returned null
    // — removing the line and the operator's 30 with it.
    const next = decrementLine({ qty: 30, unitPrice: 12 }, /* isBoxed */ true, 24);
    expect(next).not.toBeNull();
    expect(next!.qty).toBe(6);
    expect(next!.unitPrice).toBe(12); // fields still preserved
  });

  it("decrementLine keeps a typed qty below one case rather than destroying it", () => {
    // No case to remove, so the 10 units survive as an explicit loose split.
    // null stays reserved for a line that truly reaches 0 cases + 0 loose.
    expect(decrementLine({ qty: 10 }, true, 24)).toMatchObject({ qty: 10, boxes: 0, pieces: 10 });
    expect(decrementLine({ qty: 24 }, true, 24)).toBeNull();
  });

  it("setLineBoxes carries a typed plain qty over as the line's loose pieces", () => {
    // Typed 10, then the operator sets 1 case: 24 + the typed 10 = 34, never 24.
    expect(setLineBoxes({ qty: 10 }, 1, 24)).toMatchObject({ qty: 34, boxes: 1, pieces: 10 });
  });

  it("setLinePieces keeps the whole cases a typed plain qty already covers", () => {
    // Typed 30 (= 1 case + 6 loose), then the operator sets 3 loose: 24 + 3.
    expect(setLinePieces({ qty: 30 }, 3, 24)).toMatchObject({ qty: 27, boxes: 1, pieces: 3 });
  });
});
