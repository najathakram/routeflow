/**
 * TP1: merge fold + normalization units (REG-B47).
 *
 * Direct unit tests of `foldMergeItems` and the two denomination normalizers
 * (`normalizeBoxUnawareSnapshots`, `normalizeBareIncomingSellingUnits`) in
 * `./merge-items`.
 *
 * ⚠️ PROVENANCE — THE RED GATE HERE IS NOT EVIDENCE. These tests first ran
 * against a signature-only STUB of `merge-items.ts` (every export returned
 * undefined), so all seven reds read "received undefined" — informationally
 * identical to a module-not-found, and satisfiable by ANY module that returns
 * something. WP1 deleted that stub wholesale and replaced it with the real
 * module (`foldMergeItems` + friends MOVED byte-identical out of
 * `orders.controller.ts`, plus the new `normalizeBoxUnawareSnapshots`). Because
 * a stub can only ever be observed as "returned nothing", the test-plan §9
 * probe-4 MUTATION PROBES on `apps/api/src/orders/merge-items.ts` are
 * MANDATORY, not optional: they are the only thing that proves these oracles
 * bite on a real fold rather than having flipped green in one step.
 *
 * Oracles are hand-derived from the register worked examples, never from the
 * implementation: a box-UNAWARE line of a boxed product states its qty in
 * SELLING UNITS (pricing.ts's contract — unitPrice IS the box price), so 2
 * selling units + 1 box = 3 boxes = 36 pieces, and the naive qty sum (2 + 12 =
 * 14) is exactly the over/under-billing B47 describes.
 */

import {
  foldMergeItems,
  normalizeBareIncomingSellingUnits,
  normalizeBoxUnawareSnapshots,
  type MergeIncomingItem,
  type MergeLineSnapshot,
} from "./merge-items";

/**
 * SCOPE — R12 MOVE-PINS, NOT B47 PROOF. `foldMergeItems` was moved out of
 * `orders.controller.ts:35-248` byte-identical (WP1/R12); every case below
 * already produced its asserted output on the pre-F06 tree, so they go green on
 * the move alone with zero behavior change. They pin that the extraction did not
 * alter the fold — read them as such, never as evidence that B47 is fixed. The
 * file's genuine B47 unit proof is the normalization describe below (T2).
 */
describe("merge-items — box-aware fold (T1, move-pin — green after the byte-identical extraction / REG-B47)", () => {
  it("T1/REG-B47: folds a box-split existing line with an incoming box add into one line with no unitPrice", () => {
    const existingLines: MergeLineSnapshot[] = [
      {
        productId: "prod-1",
        boxes: 2,
        pieces: 0,
        qty: 24,
        unitsPerBox: 12,
        unitPrice: 10,
      },
    ];
    const incomingItems = [{ productId: "prod-1", qty: 12, boxes: 1, pieces: 0 }];

    const folded = foldMergeItems(existingLines, incomingItems);

    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({
      productId: "prod-1",
      boxes: 3,
      pieces: 0,
      qty: 36,
    });
    // derived price re-prices downstream — the fold must not carry a stale unitPrice
    expect(folded[0].unitPrice).toBeUndefined();
  });

  it("T1/REG-B47: a non-matching catalog line passes through the fold unchanged and the incoming line is appended", () => {
    const existingLines: MergeLineSnapshot[] = [
      {
        productId: "prod-unrelated",
        boxes: 1,
        pieces: 0,
        qty: 12,
        unitsPerBox: 12,
        unitPrice: 5,
      },
    ];
    const incomingItems = [{ productId: "prod-1", qty: 12, boxes: 1, pieces: 0 }];

    const folded = foldMergeItems(existingLines, incomingItems);

    // Two lines out: the untouched existing one AND the brand-new incoming one.
    // Without the length + append assertions a fold that silently dropped either
    // side would still satisfy the passthrough check alone.
    expect(folded).toHaveLength(2);
    const passthrough = folded.find((l) => String(l.productId) === "prod-unrelated");
    expect(passthrough).toMatchObject({ boxes: 1, pieces: 0, qty: 12 });
    const appended = folded.find((l) => String(l.productId) === "prod-1");
    expect(appended).toMatchObject({ boxes: 1, pieces: 0, qty: 12 });
  });

  it("T1/REG-B47: unlisted (catalog-free) lines pass through the fold on both sides as their own entries", () => {
    const existingLines: MergeLineSnapshot[] = [
      { productId: null, name: "Setup fee", qty: 1, unitPrice: 25 },
    ];
    const incomingItems = [{ name: "Pallet deposit", qty: 2, unitPrice: 15 }];

    const folded = foldMergeItems(existingLines, incomingItems);

    // The two unlisted arms of the fold — the existing snapshot and the
    // incoming item — each emit a standalone line. A fold that dropped either
    // (or dropped the unlisted list from its return) would silently delete an
    // operator's ad-hoc charge from a merged order.
    expect(folded).toHaveLength(2);
    // toEqual, not toMatchObject: an unlisted line must NOT acquire a
    // productId, boxes or pieces on the way through.
    expect(folded.find((l) => l.name === "Setup fee")).toEqual({
      name: "Setup fee",
      qty: 1,
      unitPrice: 25,
    });
    expect(folded.find((l) => l.name === "Pallet deposit")).toEqual({
      name: "Pallet deposit",
      qty: 2,
      unitPrice: 15,
    });
  });

  it("T1/REG-B47: a non-boxed product (unitsPerBox <= 1) is unaffected by box-normalization and still folds by qty", () => {
    const existingLines: MergeLineSnapshot[] = [
      {
        productId: "prod-loose",
        boxes: null,
        pieces: null,
        qty: 5,
        unitsPerBox: 1,
        unitPrice: 2,
      },
    ];
    // Box-unaware add of a loose product: no boxes/pieces keys at all.
    const incomingItems = [{ productId: "prod-loose", qty: 3 }];

    const folded = foldMergeItems(existingLines, incomingItems);

    expect(folded).toHaveLength(1);
    // toEqual, not toMatchObject: a fold that INVENTS a box split on a loose
    // line (or re-stamps the existing derived unitPrice) must go red here.
    expect(folded[0]).toEqual({ productId: "prod-loose", qty: 8 });
  });
});

describe("merge-items — box-unaware snapshot normalization (T-B47 / REG-B47)", () => {
  it("T2/REG-B47: normalizes a box-unaware snapshot via the live unitsPerBox map, then folds boxes with an incoming box add", () => {
    const existingLines: MergeLineSnapshot[] = [
      {
        productId: "prod-2",
        boxes: null,
        pieces: null,
        qty: 2,
        unitsPerBox: null,
        unitPrice: 10,
      },
    ];
    const liveUnitsPerBoxMap = new Map<string, number>([["prod-2", 12]]);
    const before = structuredClone(existingLines[0]);

    const normalized = normalizeBoxUnawareSnapshots(existingLines, liveUnitsPerBoxMap);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      productId: "prod-2",
      boxes: 2,
      pieces: 0,
      qty: 24,
      unitsPerBox: 12,
    });
    // The caller's snapshot array is the LIVE order's line set — normalization
    // must return new objects, never rewrite the rows the caller still holds.
    expect(existingLines[0]).toEqual(before);

    const incomingItems = [{ productId: "prod-2", qty: 12, boxes: 1, pieces: 0 }];
    const folded = foldMergeItems(normalized, incomingItems);

    expect(folded).toHaveLength(1);
    // hand: 2 boxes (the normalized snapshot) + 1 box = 3 boxes = 36 pieces.
    // The naive sum this replaces is {qty: 14} — a ~unitsPerBox mis-bill.
    expect(folded[0]).toMatchObject({
      productId: "prod-2",
      boxes: 3,
      pieces: 0,
      qty: 36,
    });
  });

  it("T2/REG-B47: an already-split line is left unchanged by normalization (no upb entry needed)", () => {
    const existingLines: MergeLineSnapshot[] = [
      {
        productId: "prod-3",
        boxes: 1,
        pieces: 6,
        qty: 18,
        unitsPerBox: 12,
        unitPrice: 10,
      },
    ];
    const liveUnitsPerBoxMap = new Map<string, number>();
    // Snapshot BEFORE the call. Comparing the result to `existingLines[0]`
    // instead would be vacuous: that is the very object handed in, so an
    // implementation mutating the caller's line in place would pass no matter
    // what it did to it.
    const before = structuredClone(existingLines[0]);

    const normalized = normalizeBoxUnawareSnapshots(existingLines, liveUnitsPerBoxMap);

    expect(normalized).toHaveLength(1);
    // "Unchanged" asserted in full — every field, not just the three the
    // normalizer would have rewritten.
    expect(normalized[0]).toEqual(before);
    expect(existingLines[0]).toEqual(before);
  });

  it("T2/REG-B47: a non-boxed product (unitsPerBox <= 1 in the live map) passes through normalization unchanged", () => {
    const existingLines: MergeLineSnapshot[] = [
      {
        productId: "prod-loose",
        boxes: null,
        pieces: null,
        qty: 5,
        unitsPerBox: null,
        unitPrice: 2,
      },
    ];
    const liveUnitsPerBoxMap = new Map<string, number>([["prod-loose", 1]]);
    const before = structuredClone(existingLines[0]);

    const normalized = normalizeBoxUnawareSnapshots(existingLines, liveUnitsPerBoxMap);

    expect(normalized).toHaveLength(1);
    // boxes/pieces must stay null — upb 1 is "no box", so a split of ANY size
    // (5 boxes, 0 boxes, anything) is wrong money here. Asserted against a
    // pre-call snapshot, and the input re-checked, so an in-place split of a
    // loose line — billing the wrong denomination — cannot hide behind
    // reference identity.
    expect(normalized[0]).toEqual(before);
    expect(existingLines[0]).toEqual(before);
  });

  it("T2/REG-B47: a line for a product absent from the live unitsPerBox map passes through unchanged", () => {
    const existingLines: MergeLineSnapshot[] = [
      {
        productId: "prod-unlisted-upb",
        boxes: null,
        pieces: null,
        qty: 7,
        unitsPerBox: null,
        unitPrice: 3,
      },
    ];
    const liveUnitsPerBoxMap = new Map<string, number>();
    const before = structuredClone(existingLines[0]);

    const normalized = normalizeBoxUnawareSnapshots(existingLines, liveUnitsPerBoxMap);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toEqual(before);
    expect(existingLines[0]).toEqual(before);
  });
});

/**
 * The INCOMING half of the same reconciliation. A buyer's bare `{productId, qty}`
 * counts SELLING UNITS while the fold adds it to the accumulator's PIECES — which
 * only agree while the stored line is box-UNAWARE. Against a box-SPLIT stored line
 * (the normal shape after any web/mobile cart add) a bare incoming qty lands as
 * loose pieces and under-bills by ~1/unitsPerBox, so the incoming side is expanded
 * instead. Oracles hand-derived: 2 stored boxes + a bare incoming 2 IS 4 boxes.
 */
describe("merge-items — bare incoming selling-unit expansion (T-B47 / REG-B47)", () => {
  const BOX_SPLIT_LINE: MergeLineSnapshot = {
    productId: "prod-4",
    boxes: 2,
    pieces: 0,
    qty: 24,
    unitsPerBox: 12,
    unitPrice: 10,
    priceType: "STANDARD",
  };

  it("T2/REG-B47: a bare incoming qty against a box-SPLIT stored line expands to boxes and folds to 4 boxes — never {qty:26, boxes:2, pieces:2}", () => {
    const incoming: MergeIncomingItem[] = [{ productId: "prod-4", qty: 2 }];
    const liveUnitsPerBoxMap = new Map<string, number>([["prod-4", 12]]);
    const before = structuredClone(incoming[0]);

    const expanded = normalizeBareIncomingSellingUnits(
      incoming,
      [BOX_SPLIT_LINE],
      liveUnitsPerBoxMap,
    );

    expect(expanded).toHaveLength(1);
    expect(expanded[0]).toEqual({ productId: "prod-4", qty: 24, boxes: 2, pieces: 0 });
    // New objects only — the caller still holds the client's own payload.
    expect(incoming[0]).toEqual(before);

    const folded = foldMergeItems([BOX_SPLIT_LINE], expanded);

    expect(folded).toHaveLength(1);
    // hand: 2 stored boxes + 2 ordered boxes = 4 boxes = 48 pieces. The shape this
    // replaces is {qty:26, boxes:2, pieces:2} — 2 + 2/12 boxes, a ~1/unitsPerBox
    // under-bill ($21.67 where the buyer ordered $40 of a $10 box).
    expect(folded[0]).toMatchObject({ productId: "prod-4", boxes: 4, pieces: 0, qty: 48 });
  });

  it("T2/REG-B47: a fractional selling-unit count survives the expansion as loose pieces", () => {
    // 2.5 cases of a upb-12 product is 30 pieces = 2 boxes + 6 loose — truncating
    // to 2 boxes would bin half a case of the buyer's money.
    const expanded = normalizeBareIncomingSellingUnits(
      [{ productId: "prod-4", qty: 2.5 }],
      [BOX_SPLIT_LINE],
      new Map<string, number>([["prod-4", 12]]),
    );

    expect(expanded[0]).toEqual({ productId: "prod-4", qty: 30, boxes: 2, pieces: 6 });
  });

  it("T2/REG-B47: a bare incoming qty against a box-UNAWARE stored line is left bare — both sides already count selling units", () => {
    const boxUnawareLine: MergeLineSnapshot = {
      productId: "prod-4",
      boxes: null,
      pieces: null,
      qty: 2,
      unitsPerBox: null,
      unitPrice: 10,
    };
    const incoming: MergeIncomingItem[] = [{ productId: "prod-4", qty: 2 }];
    // A live unitsPerBox IS available — the point is that it must not be applied.
    const liveUnitsPerBoxMap = new Map<string, number>([["prod-4", 12]]);

    const expanded = normalizeBareIncomingSellingUnits(
      incoming,
      [boxUnawareLine],
      liveUnitsPerBoxMap,
    );

    // toEqual: a boxes/pieces key appearing here at all flips the merged line into
    // box-split denomination and mis-bills the box-unaware stored qty beside it.
    expect(expanded[0]).toEqual({ productId: "prod-4", qty: 2 });
    expect(foldMergeItems([boxUnawareLine], expanded)[0]).toEqual({
      productId: "prod-4",
      qty: 4,
    });
  });

  it("T2/REG-B47: items that already carry a split, have no stored line, or are non-boxed pass through untouched", () => {
    const incoming: MergeIncomingItem[] = [
      // already denominated by the client — never re-expanded (that would double it)
      { productId: "prod-4", qty: 12, boxes: 1, pieces: 0 },
      // no stored line at all — nothing to agree with
      { productId: "prod-new", qty: 3 },
      // stored line is box-split but the LIVE product is not boxed any more
      { productId: "prod-loose", qty: 4 },
      // unlisted (catalog-free) items have no denomination to reconcile
      { name: "Pallet deposit", qty: 2, unitPrice: 15 },
    ];
    const looseLine: MergeLineSnapshot = {
      productId: "prod-loose",
      boxes: 1,
      pieces: 0,
      qty: 4,
      unitsPerBox: null,
      unitPrice: 2,
    };
    const liveUnitsPerBoxMap = new Map<string, number>([
      ["prod-4", 12],
      ["prod-new", 12],
      ["prod-loose", 1],
    ]);

    const expanded = normalizeBareIncomingSellingUnits(
      incoming,
      [BOX_SPLIT_LINE, looseLine],
      liveUnitsPerBoxMap,
    );

    expect(expanded).toEqual(incoming);
  });
});
