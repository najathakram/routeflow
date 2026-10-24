/**
 * SA-680 M1 (double sale): the counter sale's line DTO makes `qty` optional (a boxed line is sent as
 * boxes/pieces), and create()'s Idempotency-Key replay compares the incoming cart with the stored one by
 * `replayLineKey`. An incoming line with no qty keyed as NaN, never matched the stored piece count, and the
 * 409 "different cart" pushed the clerk onto a NEW key: a second order, a second stock decrement, a second
 * tender. The counter now shapes each line like the writer (L-226) BEFORE createSale, so the first call and
 * the retry produce the same key. REAL normalizeBoxesPieces and REAL replayLineKey: nothing mocked.
 */
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { replayLineKey } from "../unit-line-build";
import { toCounterOrderItem } from "./counter-sale-lines";

const UPB = 4;

/** What create() stores for the line the counter handed it (the writer: orders.service.ts, boxes/pieces branch). */
function storedRowFor(item: { productId?: string; qty?: number; boxes?: number; pieces?: number }) {
  const split =
    (item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0
      ? normalizeBoxesPieces({
          boxes: item.boxes,
          pieces: item.pieces,
          qty: item.qty,
          unitsPerBox: UPB,
        })
      : { qty: item.qty as number, boxes: null, pieces: null };
  return { productId: item.productId, qty: split.qty, boxes: split.boxes, pieces: split.pieces };
}

describe("a counter sale line keys identically on the first call and on a same-key retry", () => {
  it.each([
    ["boxes only", { boxes: 2 }],
    ["pieces only", { pieces: 5 }],
    ["boxes and pieces", { boxes: 1, pieces: 3 }],
    ["a plain qty", { qty: 7 }],
  ])("%s", (_n, line) => {
    const item = toCounterOrderItem({ productId: "p1", ...line } as never, UPB);
    const incoming = replayLineKey(item as never, false);
    const stored = replayLineKey(storedRowFor(item) as never, true);
    expect(incoming).not.toContain("NaN");
    expect(incoming).toBe(stored);
  });

  it("the key is stable across the retry: two calls with the same line give the same key", () => {
    const a = toCounterOrderItem({ productId: "p1", boxes: 2 } as never, UPB);
    const b = toCounterOrderItem({ productId: "p1", boxes: 2 } as never, UPB);
    expect(replayLineKey(a as never, false)).toBe(replayLineKey(b as never, false));
  });

  it("the derived qty is the integer piece count the writer stores (2 boxes of 4 = 8)", () => {
    expect(toCounterOrderItem({ productId: "p1", boxes: 2 } as never, UPB).qty).toBe(8);
    expect(toCounterOrderItem({ productId: "p1", boxes: 1, pieces: 3 } as never, UPB).qty).toBe(7);
    expect(toCounterOrderItem({ productId: "p1", pieces: 5 } as never, UPB).qty).toBe(5);
  });

  it("replayLineKey itself never yields NaN for a boxes/pieces row with no qty (derives it, or falls back)", () => {
    expect(replayLineKey({ productId: "p1", boxes: 2, unitsPerBox: UPB } as never, false)).toBe(
      "p1×8",
    );
    expect(replayLineKey({ productId: "p1", pieces: 5, unitsPerBox: UPB } as never, false)).toBe(
      "p1×5",
    );
    expect(replayLineKey({ productId: "p1", boxes: 2 } as never, false)).not.toContain("NaN");
  });

  // S1: with no pack to split by (a pack of 1, or no pack at all) the writer ignores boxes/pieces and reads
  // `qty` alone, so a line sent as {pieces:5} / {boxes:n} must carry qty = boxes + pieces, never 0 (a 400).
  describe("a pack of 1 or no pack: qty is boxes + pieces, never 0", () => {
    it.each([
      ["upb 1, pieces only", 1, { pieces: 5 }, 5],
      ["upb 1, boxes only", 1, { boxes: 3 }, 3],
      ["upb 1, boxes and pieces", 1, { boxes: 2, pieces: 3 }, 5],
      ["null pack, pieces only", null, { pieces: 5 }, 5],
      ["null pack, boxes only", null, { boxes: 4 }, 4],
    ])("%s", (_n, upb, line, expected) => {
      const item = toCounterOrderItem({ productId: "p1", ...line } as never, upb as number | null);
      expect(item.qty).toBe(expected);
      // the writer's own normaliser, which the real create() runs, agrees: it does not collapse to 0
      const written = normalizeBoxesPieces({ ...line, qty: item.qty, unitsPerBox: upb ?? 0 });
      expect(written.qty).toBe(expected);
      expect(written.qty).toBeGreaterThan(0);
    });

    it("an explicit qty wins over boxes/pieces when there is no pack", () => {
      expect(toCounterOrderItem({ productId: "p1", qty: 7, pieces: 2 } as never, 1).qty).toBe(7);
    });

    it("the replay key of such a line is stable and never NaN", () => {
      const item = toCounterOrderItem({ productId: "p1", pieces: 5 } as never, 1);
      expect(replayLineKey(item as never, false)).toBe("p1×5");
    });

    it("a boxed pack still derives the integer piece count (unchanged)", () => {
      expect(toCounterOrderItem({ productId: "p1", boxes: 2 } as never, 4).qty).toBe(8);
    });
  });
});
