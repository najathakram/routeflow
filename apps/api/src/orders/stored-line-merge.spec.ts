import { computeLineSubtotal } from "@routeflow/pricing";
import { mergeIntoStoredLine, type MergeIntoStoredLineArgs } from "./stored-line-merge";

/**
 * SA-841: the one stored-line add rule. Money is the caller's (computeLineSubtotal at the agreed unitPrice), so each
 * case also prices the result the way every caller does, to pin the dollars the ruling names.
 */
const priced = (r: ReturnType<typeof mergeIntoStoredLine>, unitPrice: number) => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return computeLineSubtotal({
    unitPrice,
    qty: r.qty,
    boxes: r.boxes,
    pieces: r.pieces,
    unitsPerBox: r.pack,
  });
};
const boxUnaware = (qty: number) => ({ qty, boxes: null, pieces: null, unitsPerBox: null });
const split = (qty: number, boxes: number, pieces: number, unitsPerBox: number | null) => ({
  qty,
  boxes,
  pieces,
  unitsPerBox,
});
const run = (
  over: Partial<MergeIntoStoredLineArgs> & Pick<MergeIntoStoredLineArgs, "line" | "add">,
) => mergeIntoStoredLine({ bare: "sellingUnits", output: "keep", livePack: 12, ...over });

describe("mergeIntoStoredLine (SA-841)", () => {
  it("F1 keep: 1 box filed as a split into a box-unaware 1-box line → 2 boxes, unpromoted, $80; adds 1 box", () => {
    const r = run({ line: boxUnaware(1), add: { qty: 12, boxes: 1, pieces: 0 } });
    expect(r).toMatchObject({
      ok: true,
      qty: 2,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      addInLineUnit: 1,
      usedLivePack: true,
    });
    expect(priced(r, 40)).toBe(80);
  });

  it("F2 keep: a bare selling unit into a 12-pack split line → 2 boxes, $80", () => {
    const r = run({ line: split(12, 1, 0, 12), add: { qty: 1 } });
    expect(r).toMatchObject({
      ok: true,
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      addInLineUnit: 12,
      usedLivePack: false,
    });
    expect(priced(r, 40)).toBe(80);
  });

  it("R3: the line's own split pack (12) wins over a live 6: 2 boxes + 1b6p → 3 boxes + 6, $140", () => {
    const r = run({
      line: split(24, 2, 0, null),
      add: { qty: 18, boxes: 1, pieces: 6 },
      livePack: 6,
    });
    expect(r).toMatchObject({
      ok: true,
      qty: 42,
      boxes: 3,
      pieces: 6,
      unitsPerBox: 12,
      usedLivePack: false,
    });
    expect(priced(r, 40)).toBe(140);
  });

  it("R4: a bare selling unit into a 12-pack line of a product now sold as a 6-pack → PACK_MISMATCH 12 vs 6", () => {
    expect(run({ line: split(24, 2, 0, 12), add: { qty: 1 }, livePack: 6 })).toEqual({
      ok: false,
      reason: "PACK_MISMATCH",
      linePack: 12,
      addPack: 6,
    });
  });

  it("a filed split at another pack than the line's → PACK_MISMATCH naming the filed pack", () => {
    expect(run({ line: split(24, 2, 0, 12), add: { qty: 6, boxes: 1, pieces: 0 } })).toEqual({
      ok: false,
      reason: "PACK_MISMATCH",
      linePack: 12,
      addPack: 6,
    });
  });

  it("R5 keep: loose pieces into a box-unaware line → LOOSE_INTO_BOX_UNAWARE (SA-104a)", () => {
    expect(run({ line: boxUnaware(1), add: { qty: 5, boxes: 0, pieces: 5 } })).toMatchObject({
      ok: false,
      reason: "LOOSE_INTO_BOX_UNAWARE",
    });
  });

  it("split + pieces (R6 staff bare into box-unaware): 2 boxes + 1 loose → 2 boxes + 1 pc re-split, $20.83", () => {
    const r = run({
      line: boxUnaware(2),
      add: { qty: 1 },
      bare: "pieces",
      output: "split",
      livePack: 12,
    });
    expect(r).toMatchObject({ ok: true, qty: 25, boxes: 2, pieces: 1, unitsPerBox: 12 });
    expect(priced(r, 10)).toBe(20.83);
  });

  it("split (R1 staff boxed): box-unaware 1 + a scanned box → 2 boxes, $20.00", () => {
    const r = run({
      line: boxUnaware(1),
      add: { qty: 12, boxes: 1, pieces: 0 },
      bare: "pieces",
      output: "split",
    });
    expect(r).toMatchObject({ ok: true, qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
    expect(priced(r, 10)).toBe(20);
  });

  it("split (R2 staff mixed): box-unaware 2 + 1 box 6 pcs → 3 boxes + 6, $35.00", () => {
    const r = run({
      line: boxUnaware(2),
      add: { qty: 18, boxes: 1, pieces: 6 },
      bare: "pieces",
      output: "split",
    });
    expect(r).toMatchObject({ ok: true, qty: 42, boxes: 3, pieces: 6, unitsPerBox: 12 });
    expect(priced(r, 10)).toBe(35);
  });

  it("no pack: a plain sum (G1: 10 + 5 = 15), never a box concept", () => {
    expect(run({ line: boxUnaware(10), add: { qty: 5 }, livePack: 0 })).toEqual({
      ok: true,
      qty: 15,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      pack: 0,
      addInLineUnit: 5,
      usedLivePack: false,
    });
  });

  it("no pack: an add carrying a whole box → BOXED_INTO_UNPACKAGED (SA-104a(1))", () => {
    expect(
      run({ line: boxUnaware(10), add: { qty: 12, boxes: 1, pieces: 0 }, livePack: 1 }),
    ).toMatchObject({
      ok: false,
      reason: "BOXED_INTO_UNPACKAGED",
    });
  });

  it("a box-aware line never falls back to the live pack: usedLivePack false even when live differs", () => {
    const r = run({ line: split(12, 1, 0, 12), add: { qty: 6, boxes: 0, pieces: 6 }, livePack: 6 });
    expect(r).toMatchObject({
      ok: true,
      qty: 18,
      boxes: 1,
      pieces: 6,
      unitsPerBox: 12,
      usedLivePack: false,
    });
  });

  it.each([[0], [1]])(
    "MUST-1 G1 (live pack %i): a non-boxed add filed as {qty 5, boxes 0, pieces 0} adds its qty: 10 + 5 = 15, never 0",
    (livePack) => {
      const r = run({ line: boxUnaware(10), add: { qty: 5, boxes: 0, pieces: 0 }, livePack });
      expect(r).toMatchObject({ ok: true, qty: 15, boxes: null, pieces: null, addInLineUnit: 5 });
      expect(priced(r, 8.5)).toBe(127.5);
    },
  );

  it("MUST-1 G1: a line with a stamped pack <= 1 and an all-zero split add still adds the qty", () => {
    const r = run({
      line: { qty: 10, boxes: null, pieces: null, unitsPerBox: 1 },
      add: { qty: 5, boxes: 0, pieces: 0 },
      livePack: 0,
    });
    expect(r).toMatchObject({ ok: true, qty: 15, addInLineUnit: 5 });
  });

  it("(c) a unitsPerBox snapshot with boxes null is box-UNAWARE: keep adds whole boxes, never promotes", () => {
    const r = run({
      line: { qty: 2, boxes: null, pieces: null, unitsPerBox: 12 },
      add: { qty: 12, boxes: 1, pieces: 0 },
    });
    expect(r).toMatchObject({
      ok: true,
      qty: 3,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      pack: 12,
      addInLineUnit: 1,
      usedLivePack: false,
    });
  });

  it("MUST-1b: at pack > 1 an all-zero split ({5, 0, 0}) is ambiguous and refused, never an ok with nothing added", () => {
    // (1) a 12-pack line after the product went unboxed (live 0)
    expect(
      run({ line: split(24, 2, 0, 12), add: { qty: 5, boxes: 0, pieces: 0 }, livePack: 0 }),
    ).toEqual({
      ok: false,
      reason: "EMPTY_ADD",
      linePack: 12,
      addPack: null,
    });
    // (2) a box-unaware line while the product is boxed live, from a stale client
    expect(
      run({ line: boxUnaware(2), add: { qty: 5, boxes: 0, pieces: 0 }, livePack: 12 }),
    ).toMatchObject({
      ok: false,
      reason: "EMPTY_ADD",
    });
    // a plain zero add is EMPTY_ADD too, never a pack mismatch
    expect(run({ line: boxUnaware(10), add: { qty: 0 }, livePack: 0 })).toMatchObject({
      ok: false,
      reason: "EMPTY_ADD",
    });
  });

  it("invariant: a merge never returns ok with a zero add (every line shape x add shape x pack)", () => {
    const lines = [
      boxUnaware(2),
      split(24, 2, 0, 12),
      split(24, 2, 0, null),
      { qty: 2, boxes: null, pieces: null, unitsPerBox: 12 },
    ];
    const adds = [
      { qty: 5, boxes: 0, pieces: 0 },
      { qty: 0, boxes: 0, pieces: 0 },
      { qty: 0 },
      { qty: 5 },
      { qty: 12, boxes: 1, pieces: 0 },
      { qty: 5, boxes: 0, pieces: 5 },
    ];
    let okCount = 0;
    for (const line of lines)
      for (const add of adds)
        for (const livePack of [0, 1, 6, 12])
          for (const bare of ["sellingUnits", "pieces"] as const)
            for (const output of ["keep", "split"] as const) {
              const r = mergeIntoStoredLine({ line, add, livePack, bare, output });
              if (r.ok) {
                okCount++;
                expect({
                  line,
                  add,
                  livePack,
                  bare,
                  output,
                  added: r.addInLineUnit > 0,
                }).toMatchObject({ added: true });
              }
            }
    // never vacuous: the grid must contain real merges, not only refusals
    expect(okCount).toBeGreaterThan(0);
  });

  it.each([[-3], [Number.NaN]])(
    "a negative or NaN add qty (%s) is EMPTY_ADD, never an ok (callers validate upstream)",
    (qty) => {
      expect(run({ line: boxUnaware(10), add: { qty }, livePack: 0 })).toMatchObject({
        ok: false,
        reason: "EMPTY_ADD",
      });
      expect(run({ line: split(24, 2, 0, 12), add: { qty }, livePack: 12 })).toMatchObject({
        ok: false,
        reason: "EMPTY_ADD",
      });
    },
  );
});
