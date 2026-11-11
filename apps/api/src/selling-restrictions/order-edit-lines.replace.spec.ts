import { readFileSync } from "fs";
import { join } from "path";
import { denominationGate } from "../orders/buyer-denomination";
import {
  replaceIsPieces,
  sellableLinesForChangeRequest,
  sellableLinesForReplaceEdit,
  type EditItem,
  type ExistingLine,
  type LiveUnitsPerBox,
  type ReplaceActor,
} from "./order-edit-lines";

const line = (over: Partial<ExistingLine> = {}): ExistingLine => ({
  id: "li-1",
  productId: "p1",
  qty: 5,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  status: "PENDING",
  ...over,
});
const items = (...list: Array<Record<string, unknown>>): EditItem[] => list as EditItem[];
/** box size 12 for p1 unless a case says otherwise */
const LIVE12: LiveUnitsPerBox = new Map([["p1", 12]]);
const LOOSE: LiveUnitsPerBox = new Map([["p1", null]]);

// SA-1132: `isPieces` is the write's own builder (`replaceIsPieces` = `denominationGate`), as the plan passes it.
const replace = (
  existing: ExistingLine[],
  payload: EditItem[],
  actor: ReplaceActor = "staff",
  live?: LiveUnitsPerBox,
  namesLines = false,
) =>
  sellableLinesForReplaceEdit(existing, payload, {
    actor,
    liveUnitsPerBox: live,
    isPieces: replaceIsPieces(existing, actor, namesLines),
  });

describe("sellableLinesForReplaceEdit", () => {
  it("a product NOT on the order is a new line when anything can be written; a qty-less item writes nothing", () => {
    expect(replace([line()], items({ productId: "p2", qty: 3 }))).toStrictEqual([
      { productId: "p2" },
    ]);
    expect(replace([line()], items({ productId: "p2", boxes: 1 }))).toStrictEqual([
      { productId: "p2" },
    ]);
    // a split with no qty writes nothing on the buyer / driver branch (`if (!item.qty) continue`)
    expect(replace([line()], items({ productId: "p2", boxes: 1 }), "buyer")).toEqual([]);
    expect(replace([line()], items({ productId: "p2" }, { productId: "p2", qty: 0 }))).toEqual([]);
  });

  it("an UNREADABLE qty is never a removal: checked, whatever else the product's items say", () => {
    for (const actor of ["staff", "buyer", "driver"] as const)
      expect(
        replace([line()], items({ productId: "p1", qty: Number.NaN }), actor, LOOSE),
      ).toStrictEqual([{ productId: "p1" }]);
  });

  it("a cancelled line carries nothing: a product held only by CANCELLED rows is a NEW line", () => {
    const cancelled = line({ status: "CANCELLED", qty: 24 });
    expect(replace([cancelled], items({ productId: "p1", qty: 1 }), "staff", LOOSE)).toStrictEqual([
      { productId: "p1" },
    ]);
  });

  describe("a loose product (live box size <= 1): raw quantities", () => {
    it.each([
      ["an increase", 8, 3],
      ["an echo", 5, 0],
      ["a decrease", 2, -3],
    ])("%s carries the net delta", (_l, qty, delta) => {
      expect(replace([line()], items({ productId: "p1", qty }), "staff", LOOSE)).toStrictEqual([
        { productId: "p1", qtyDelta: delta },
      ]);
    });

    it("items of one product are summed; a dropped product and a qty-less item are removals (never checked)", () => {
      expect(
        replace(
          [line()],
          items({ productId: "p1", qty: 4 }, { productId: "p1", qty: 3 }),
          "staff",
          LOOSE,
        ),
      ).toStrictEqual([{ productId: "p1", qtyDelta: 2 }]);
      expect(replace([line()], items({ productId: "p9", qty: 1 }), "staff", LOOSE)).toStrictEqual([
        { productId: "p9" },
      ]);
      expect(replace([line()], items({ productId: "p1" }), "staff", LOOSE)).toEqual([]);
      expect(replace([line()], [], "staff", LOOSE)).toEqual([]);
    });

    it("`id`, `action` and an unlisted line are ignored for sizing; a substitute is checked (unsized) but never written", () => {
      expect(
        replace(
          [line()],
          items({ id: "li-1", action: "CANCEL", productId: "p1", qty: 9 }),
          "staff",
          LOOSE,
        ),
      ).toStrictEqual([{ productId: "p1", qtyDelta: 4 }]);
      expect(
        replace([line()], items({ name: "Delivery", qty: 1, unitPrice: 5 }), "staff", LOOSE),
      ).toEqual([]);
      expect(
        replace(
          [line()],
          items({ productId: "p1", qty: 5, substituteProductId: "p9" }),
          "staff",
          LOOSE,
        ),
      ).toStrictEqual([{ productId: "p9" }, { productId: "p1", qtyDelta: 0 }]);
    });
  });

  it("a pure REMOVAL of an existing product needs no box size — never checked, even when the caller supplied none", () => {
    expect(replace([line()], items({ productId: "p1" }), "staff", new Map())).toEqual([]);
    expect(replace([line()], items({ productId: "p1", boxes: 2 }), "buyer", new Map())).toEqual([]);
  });

  it("an existing product whose live box size the caller did not supply is UNSIZED — checked, never guessed", () => {
    expect(replace([line()], items({ productId: "p1", qty: 1 }), "staff", new Map())).toStrictEqual(
      [{ productId: "p1" }],
    );
    expect(replace([line()], items({ productId: "p1", qty: 1 }))).toStrictEqual([
      { productId: "p1" },
    ]);
  });

  describe("a boxed product (live size 12): compared in PIECES", () => {
    const pieces = line({ qty: 24, boxes: 2, pieces: 0 }); // 2 cases stored as 24 pieces
    const cases = line({ qty: 5 }); // box-unaware: 5 CASES = 60 pieces

    it("STAFF: a bare qty is selling units (cases) — 5 cases against 24 stored pieces is an INCREASE (+36), not a 'decrease' 5 < 24", () => {
      const at = (qty: number) =>
        replace([pieces], items({ productId: "p1", qty }), "staff", LIVE12);
      expect(at(5)).toStrictEqual([{ productId: "p1", qtyDelta: 36 }]);
      expect(at(2)).toStrictEqual([{ productId: "p1", qtyDelta: 0 }]);
      expect(at(1)).toStrictEqual([{ productId: "p1", qtyDelta: -12 }]);
    });

    it("STAFF: a split writes boxes × size + pieces (qty ignored); a box-unaware line's cases are converted", () => {
      const at = (over: Record<string, unknown>) =>
        replace([cases], items({ productId: "p1", ...over }), "staff", LIVE12);
      expect(at({ boxes: 1 })).toStrictEqual([{ productId: "p1", qtyDelta: -48 }]);
      expect(at({ boxes: 6 })).toStrictEqual([{ productId: "p1", qtyDelta: 12 }]);
      expect(at({ pieces: 7, qty: 99 })).toStrictEqual([{ productId: "p1", qtyDelta: -53 }]);
    });

    // SA-1132: the check reads an edited item the same way the order does (`isPieces` = the write's builder).
    const boxedOne = line({ qty: 12, boxes: 1, pieces: 0 }); // 1 box of 12, stored 12 pieces
    const packLine = line({ id: "li-pack", qty: 2 }); // box-unaware: 2 packs = 24 pieces

    it("M-1: an unnamed buyer re-add under namesLines is the pack (2 packs = 24 pieces against 12: +12)", () => {
      const at = (over: Record<string, unknown>) =>
        replace([boxedOne], items({ productId: "p1", qty: 2, ...over }), "buyer", LIVE12, true);
      expect(at({})).toStrictEqual([{ productId: "p1", qtyDelta: 12 }]);
      // the named box-split line and an explicit split stay pieces (2 against 12)
      expect(at({ orderItemId: "li-1" })).toStrictEqual([{ productId: "p1", qtyDelta: -10 }]);
      expect(at({ pieces: 2 })).toStrictEqual([{ productId: "p1", qtyDelta: -10 }]);
    });

    it("M-2: a buyer entry naming a pack line beside a box-split line is counted in packs (3 packs + 12 pieces = 48 against 36: +12)", () => {
      const rows = [packLine, line({ id: "li-box", qty: 12, boxes: 1, pieces: 0 })];
      const at = (namesLines: boolean) =>
        replace(
          rows,
          items(
            { productId: "p1", qty: 3, orderItemId: "li-pack" },
            { productId: "p1", qty: 12, orderItemId: "li-box" },
          ),
          "buyer",
          LIVE12,
          namesLines,
        );
      expect(at(true)).toStrictEqual([{ productId: "p1", qtyDelta: 12 }]); // 36 + 12 against 36
      expect(at(false)).toStrictEqual([{ productId: "p1", qtyDelta: 12 }]); // the named line decides either way
    });

    it("M-3 (guard): a driver's bare qty is still pieces when a row of the product is box-split, cases when none is", () => {
      expect(
        replace([boxedOne], items({ productId: "p1", qty: 30 }), "driver", LIVE12),
      ).toStrictEqual([{ productId: "p1", qtyDelta: 18 }]);
      expect(
        replace([packLine], items({ productId: "p1", qty: 3 }), "driver", LIVE12),
      ).toStrictEqual([{ productId: "p1", qtyDelta: 12 }]);
    });

    it("parity: over the R-1..R-4 and M-1..M-3 shapes, the check's reading equals the write's denominationGate", () => {
      const shapes: Array<[ReplaceActor, ExistingLine[], EditItem, boolean]> = [
        ["buyer", [boxedOne], { productId: "p1", qty: 2 }, true], // R-1 / M-1
        ["buyer", [boxedOne], { productId: "p1", qty: 2 }, false], // R-2
        ["buyer", [boxedOne], { productId: "p1", qty: 2, boxes: 2 } as EditItem, true], // R-3
        ["buyer", [boxedOne], { productId: "p1", qty: 1 }, true], // R-4 (web / mobile re-add)
        ["buyer", [packLine, boxedOne], { productId: "p1", qty: 3, orderItemId: "li-pack" }, true], // M-2
        [
          "buyer",
          [line({ status: "CANCELLED", qty: 12, boxes: 1, pieces: 0 }), packLine],
          { productId: "p1", qty: 3 },
          false,
        ],
        ["driver", [boxedOne], { productId: "p1", qty: 30 }, false], // M-3
        ["driver", [packLine], { productId: "p1", qty: 3 }, false], // M-3
      ];
      for (const [actor, rows, entry, namesLines] of shapes) {
        const write = denominationGate(rows, actor === "buyer", namesLines).isPieces({
          productId: entry.productId,
          boxes: entry.boxes,
          pieces: entry.pieces,
          sourceLineId: actor === "buyer" ? entry.orderItemId : entry.id,
        });
        const bare = entry.qty ?? 0;
        const before = rows
          .filter((l) => l.status !== "CANCELLED")
          .reduce(
            (s, l) =>
              s + (l.boxes == null && l.pieces == null ? Number(l.qty) * 12 : Number(l.qty)),
            0,
          );
        expect([actor, replace(rows, [entry], actor, LIVE12, namesLines)]).toStrictEqual([
          actor,
          [{ productId: "p1", qtyDelta: (write ? bare : bare * 12) - before }],
        ]);
      }
    });

    it("structural: order-edit-lines.ts decides no pack-or-pieces rule of its own (no bareIsPieces, no pieceRows)", () => {
      const src = readFileSync(join(__dirname, "order-edit-lines.ts"), "utf8");
      expect(src).not.toMatch(/\bbareIsPieces\b|\bpieceRows\b/);
    });

    // SA-1132 SUPERSEDED: the unnamed-buyer rows below are the legacy (`namesLines: false`) reading only.
    it("BUYER (legacy, namesLines false): qty is PIECES when the product's live lines are all piece-denominated (or a split rides along), else cases", () => {
      const at = (existing: ExistingLine[], over: Record<string, unknown>) =>
        replace(existing, items({ productId: "p1", ...over }), "buyer", LIVE12);
      expect(at([pieces], { qty: 12 })).toStrictEqual([{ productId: "p1", qtyDelta: -12 }]);
      expect(at([pieces], { qty: 30 })).toStrictEqual([{ productId: "p1", qtyDelta: 6 }]);
      expect(at([cases], { qty: 4 })).toStrictEqual([{ productId: "p1", qtyDelta: -12 }]); // 48 vs 60
      expect(at([cases], { qty: 6 })).toStrictEqual([{ productId: "p1", qtyDelta: 12 }]);
      expect(at([cases], { qty: 24, boxes: 2 })).toStrictEqual([
        { productId: "p1", qtyDelta: -36 },
      ]);
      expect(at([pieces], { boxes: 5 })).toEqual([]); // a split with no qty writes nothing
    });

    it("BUYER: the denomination is decided PER ITEM — a sibling bare item is still cases (review BLOCKER: 61 pieces written against 12 carried)", () => {
      const one = line({ qty: 1 }); // 1 case = 12 pieces
      expect(
        replace(
          [one],
          items({ productId: "p1", qty: 1, boxes: 1 }, { productId: "p1", qty: 5 }),
          "buyer",
          LIVE12,
        ),
      ).toStrictEqual([{ productId: "p1", qtyDelta: 49 }]); // 1 piece + 60 pieces vs 12
    });

    // SUPERSEDED by SA-1132 (the check reads the write's decision): SA-422 (3) already made the write ignore
    // a seller-CANCELLED row for a buyer, so 30 is 30 cases = 360 pieces against 60. The old pin read 30 pieces.
    it("BUYER: a CANCELLED piece-denominated row does not denominate a buyer entry (SA-422 live lines) — 30 cases against 60 pieces is a raise", () => {
      const rows = [line({ id: "old", status: "CANCELLED", qty: 12, boxes: 1, pieces: 0 }), cases];
      expect(replace(rows, items({ productId: "p1", qty: 30 }), "buyer", LIVE12)).toStrictEqual([
        { productId: "p1", qtyDelta: 300 },
      ]);
    });

    it("STAFF: a split item beside a bare item of one product is sized per item (24 pieces + 2 cases = 48)", () => {
      expect(
        replace(
          [pieces],
          items({ productId: "p1", boxes: 2 }, { productId: "p1", qty: 2 }),
          "staff",
          LIVE12,
        ),
      ).toStrictEqual([{ productId: "p1", qtyDelta: 24 }]);
    });

    it("DRIVER: like the buyer, but a split does not turn a bare qty into pieces", () => {
      const at = (existing: ExistingLine[], over: Record<string, unknown>) =>
        replace(existing, items({ productId: "p1", ...over }), "driver", LIVE12);
      expect(at([pieces], { qty: 12 })).toStrictEqual([{ productId: "p1", qtyDelta: -12 }]);
      expect(at([cases], { qty: 24, boxes: 2 })).toStrictEqual([
        { productId: "p1", qtyDelta: 228 },
      ]); // 24 cases
    });
  });
});

describe("sellableLinesForChangeRequest", () => {
  const cr = (type: string, over: Record<string, unknown> = {}) => ({ type, ...over });

  it("ADD_ITEM is always checked — the product comes from the row, else the payload", () => {
    expect(sellableLinesForChangeRequest(cr("ADD_ITEM", { productId: "p2" }), [])).toStrictEqual([
      { productId: "p2" },
    ]);
    expect(
      sellableLinesForChangeRequest(cr("ADD_ITEM", { payload: { productId: "p3", qty: 1 } }), []),
    ).toStrictEqual([{ productId: "p3" }]);
    expect(sellableLinesForChangeRequest(cr("ADD_ITEM"), [])).toEqual([]);
  });

  it("CHANGE_QTY is newQty − the line's qty: an increase is positive, a cut negative", () => {
    const at = (newQty: unknown) =>
      sellableLinesForChangeRequest(
        cr("CHANGE_QTY", { orderItemId: "li-1", payload: { newQty } }),
        [line()],
      );
    expect(at(8)).toStrictEqual([{ productId: "p1", qtyDelta: 3 }]);
    expect(at(2)).toStrictEqual([{ productId: "p1", qtyDelta: -3 }]);
    expect(at("7")).toStrictEqual([{ productId: "p1", qtyDelta: 2 }]);
  });

  it("an unreadable newQty is unsized (checked); no target line, an unlisted line, REMOVE_ITEM and NOTE add nothing", () => {
    const base = { orderItemId: "li-1" };
    expect(
      sellableLinesForChangeRequest(cr("CHANGE_QTY", { ...base, payload: {} }), [line()]),
    ).toStrictEqual([{ productId: "p1" }]);
    expect(
      sellableLinesForChangeRequest(
        cr("CHANGE_QTY", { payload: { orderItemId: "li-1", newQty: 9 } }),
        [line()],
      ),
    ).toStrictEqual([{ productId: "p1", qtyDelta: 4 }]);
    expect(
      sellableLinesForChangeRequest(cr("CHANGE_QTY", { ...base, payload: { newQty: 9 } }), []),
    ).toEqual([]);
    expect(
      sellableLinesForChangeRequest(cr("CHANGE_QTY", { ...base, payload: { newQty: 9 } }), [
        line({ productId: null }),
      ]),
    ).toEqual([]);
    expect(sellableLinesForChangeRequest(cr("REMOVE_ITEM", base), [line()])).toEqual([]);
    expect(sellableLinesForChangeRequest(cr("NOTE"), [line()])).toEqual([]);
  });
});
