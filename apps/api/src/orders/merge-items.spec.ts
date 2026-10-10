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

    const { items: folded } = foldMergeItems(existingLines, incomingItems);

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

    const { items: folded } = foldMergeItems(existingLines, incomingItems);

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

    const { items: folded } = foldMergeItems(existingLines, incomingItems);

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

    const { items: folded } = foldMergeItems(existingLines, incomingItems);

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
    const { items: folded } = foldMergeItems(normalized, incomingItems);

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

    const { items: folded } = foldMergeItems([BOX_SPLIT_LINE], expanded);

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
    expect(foldMergeItems([boxUnawareLine], expanded).items[0]).toEqual({
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

describe("merge-items — overrideReason threading (B465 fix round 2, Opus BLOCK item 3)", () => {
  // A MANUAL-priced existing line's unitPrice survives the fold (R0), but its
  // overrideReason never did — `MergeLineSnapshot` had no such field. If that
  // MANUAL line's product also resolves to SPECIAL tier for this customer,
  // updateOrderItems's B465 guard (a price change on a SPECIAL line needs a
  // documented reason) would refuse the merge outright even though nothing
  // about the price is actually changing: the fold just dropped the reason
  // that already justified it.
  it("REG-B465-MERGE-1: a surviving MANUAL override's overrideReason folds through alongside its unitPrice", () => {
    const existingLines: MergeLineSnapshot[] = [
      {
        productId: "prod-1",
        qty: 3,
        unitPrice: 12,
        priceType: "MANUAL",
        overrideReason: "manager approved",
      },
    ];
    const incoming: MergeIncomingItem[] = [{ productId: "prod-1", qty: 2 }];

    const { items: merged } = foldMergeItems(existingLines, incoming);

    expect(merged).toEqual([
      expect.objectContaining({
        productId: "prod-1",
        unitPrice: 12,
        overrideReason: "manager approved",
      }),
    ]);
  });

  it("REG-B465-MERGE-2: a derived (non-MANUAL) line's price does NOT survive the fold, so its overrideReason (if any, e.g. stale data) is never carried either", () => {
    const existingLines: MergeLineSnapshot[] = [
      {
        productId: "prod-1",
        qty: 3,
        unitPrice: 8,
        priceType: "SPECIAL",
        overrideReason: null,
      },
    ];
    const incoming: MergeIncomingItem[] = [{ productId: "prod-1", qty: 2 }];

    const { items: merged } = foldMergeItems(existingLines, incoming);

    expect(merged[0]).not.toHaveProperty("unitPrice");
    expect(merged[0]).not.toHaveProperty("overrideReason");
  });

  it("REG-B465-MERGE-3: a brand-new merged line (no existing counterpart) never fabricates an overrideReason", () => {
    const { items: merged } = foldMergeItems(
      [],
      [{ productId: "prod-new", qty: 2, unitPrice: 12 }],
    );

    expect(merged).toEqual([expect.objectContaining({ productId: "prod-new", unitPrice: 12 })]);
    expect(merged[0]).not.toHaveProperty("overrideReason");
  });

  // #2696(c) SA-558d: the create auto-merge's NEW line takes create's rule A, which needs the
  // reason on a special line — the fold dropped the incoming one, so a documented staff override
  // 400'd when it merged into a pending order (found by the F2 real-PG parity pin).
  it("#2696-MERGE-4: a brand-new merged line carries the INCOMING reason with its incoming price", () => {
    const { items: merged } = foldMergeItems(
      [],
      [{ productId: "prod-new", qty: 2, unitPrice: 6, overrideReason: "bent box" }],
    );
    expect(merged).toEqual([
      expect.objectContaining({ productId: "prod-new", unitPrice: 6, overrideReason: "bent box" }),
    ]);
  });

  it("#2696-MERGE-5: an incoming price that FILLS a priceless MANUAL bucket brings its reason; an existing price keeps its own", () => {
    const filled = foldMergeItems(
      [{ productId: "prod-1", qty: 3, priceType: "MANUAL" }],
      [{ productId: "prod-1", qty: 2, unitPrice: 6, overrideReason: "bent box" }],
    ).items;
    expect(filled[0]).toMatchObject({ unitPrice: 6, overrideReason: "bent box" });

    const kept = foldMergeItems(
      [{ productId: "prod-1", qty: 3, unitPrice: 12, priceType: "MANUAL", overrideReason: "old" }],
      [{ productId: "prod-1", qty: 2, unitPrice: 6, overrideReason: "new" }],
    ).items;
    expect(kept[0]).toMatchObject({ unitPrice: 12, overrideReason: "old" });
  });
});

describe("merge-items — B776 (SA-101(1)(d)): a genuine pack disagreement REFUSES, never re-denominates", () => {
  it("stored at a 12-pack, scanned as a 6-pack: refuses naming both packs, before mutating anything", () => {
    const existingLines: MergeLineSnapshot[] = [
      { productId: "prod-repack", boxes: 1, pieces: 0, qty: 12, unitsPerBox: 12, unitPrice: 36 },
    ];
    const incoming: MergeIncomingItem[] = [
      { productId: "prod-repack", qty: 6, boxes: 1, pieces: 0 },
    ];

    expect(() => foldMergeItems(existingLines, incoming)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: "MERGE_PACK_MISMATCH",
          productId: "prod-repack",
          existingPacks: [12],
          incomingPack: 6,
        }),
      }),
    );
  });

  it("a disagreeing pack for ONE product never re-denominates an untouched sibling line", () => {
    const existingLines: MergeLineSnapshot[] = [
      { productId: "prod-repack", boxes: 1, pieces: 0, qty: 12, unitsPerBox: 12, unitPrice: 36 },
      { productId: "prod-fine", boxes: 1, pieces: 0, qty: 12, unitsPerBox: 12, unitPrice: 24 },
    ];
    const incoming: MergeIncomingItem[] = [
      { productId: "prod-fine", qty: 12, boxes: 1, pieces: 0 },
      { productId: "prod-repack", qty: 6, boxes: 1, pieces: 0 },
    ];

    // prod-fine is processed first and folds cleanly; prod-repack's disagreement still throws —
    // the whole call fails atomically (the caller never sees a partial merge).
    expect(() => foldMergeItems(existingLines, incoming)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: "MERGE_PACK_MISMATCH" }),
      }),
    );
  });

  it("an UNRESOLVED accumulator pack (box-unaware existing line) still adopts the incoming pack, no refusal", () => {
    // acc.unitsPerBox starts at 0 (existing line has no boxes/pieces) — not a disagreement,
    // the existing "own pack, else packFromOwnSplit, else live" precedence's normal fill-in.
    const existingLines: MergeLineSnapshot[] = [
      { productId: "prod-1", qty: 2, unitPrice: 36 }, // box-unaware, boxes/pieces both null
    ];
    const incoming: MergeIncomingItem[] = [{ productId: "prod-1", qty: 12, boxes: 1, pieces: 0 }];

    expect(() => foldMergeItems(existingLines, incoming)).not.toThrow();
  });

  it("agreeing packs still fold normally — the refusal never fires on a genuine match", () => {
    const existingLines: MergeLineSnapshot[] = [
      { productId: "prod-1", boxes: 1, pieces: 0, qty: 12, unitsPerBox: 12, unitPrice: 36 },
    ];
    const incoming: MergeIncomingItem[] = [{ productId: "prod-1", qty: 12, boxes: 1, pieces: 0 }];

    const { items: folded } = foldMergeItems(existingLines, incoming);
    expect(folded[0]).toMatchObject({ boxes: 2, pieces: 0, qty: 24 });
  });
});

describe("merge-items — SA-124a: existing lines keyed by productId + resolved pack (not productId alone)", () => {
  // The order already carries TWO lines for the same product, at two different packs — the
  // durable result of an earlier pack-mismatch sweep (B776). Before this round, `foldMergeItems`
  // keyed its accumulator by productId ALONE (a `Map<string, Acc>`), so building that map from
  // `existingLines` silently OVERWROTE the first of the two lines before any incoming item was
  // even considered — a genuine data-loss bug, independent of the disagreement-refusal above.
  const winnerAt12: MergeLineSnapshot = {
    productId: "prod-split",
    boxes: 1,
    pieces: 0,
    qty: 12,
    unitsPerBox: 12,
    unitPrice: 36,
  };
  const winnerAt6: MergeLineSnapshot = {
    productId: "prod-split",
    boxes: 1,
    pieces: 0,
    qty: 6,
    unitsPerBox: 6,
    unitPrice: 18,
  };

  it("a replace-all scan of a 6-pack grows the 6-pack line; the 12-pack line survives byte-identical — NO DELETE", () => {
    const incoming: MergeIncomingItem[] = [
      { productId: "prod-split", qty: 6, boxes: 1, pieces: 0 },
    ];

    const { items } = foldMergeItems([winnerAt12, winnerAt6], incoming);

    expect(items).toHaveLength(2);
    const twelvePackLine = items.find((i) => i.boxes === 1 && i.qty === 12);
    const sixPackLine = items.find((i) => i.qty === 12 && i.boxes === 2);
    // the 12-pack line survives byte-identical in SHAPE — NO DELETE, no re-split, still its
    // own 1-box/12-qty line (unitPrice is dropped here regardless of which bucket, MANUAL
    // aside — R0's existing re-price-on-replaceAll rule, unrelated to this pin).
    expect(twelvePackLine).toMatchObject({ productId: "prod-split", boxes: 1, pieces: 0, qty: 12 });
    // the 6-pack line: grew from 1 box to 2 (6 + 6 scanned pieces = 2 boxes of 6) — the loser
    // folded into the MATCHING pack, never the 12-pack line, and no third line was created.
    expect(sixPackLine).toMatchObject({ productId: "prod-split", boxes: 2, pieces: 0 });
  });

  it("a scan at a THIRD pack (24) matching neither stored line refuses naming both existing packs", () => {
    const incoming: MergeIncomingItem[] = [
      { productId: "prod-split", qty: 24, boxes: 1, pieces: 0 },
    ];

    expect(() => foldMergeItems([winnerAt12, winnerAt6], incoming)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: "MERGE_PACK_MISMATCH",
          productId: "prod-split",
          existingPacks: [6, 12],
          incomingPack: 24,
        }),
      }),
    );
  });

  it("SA-124e MED-5: two SAME-pack duplicate existing lines each keep their own bucket — a scan folds into the FIRST, the second survives byte-identical", () => {
    const first: MergeLineSnapshot = {
      productId: "prod-dup",
      boxes: 1,
      pieces: 0,
      qty: 12,
      unitsPerBox: 12,
      unitPrice: 36,
      priceType: "STANDARD",
    };
    const second: MergeLineSnapshot = {
      productId: "prod-dup",
      boxes: 2,
      pieces: 0,
      qty: 24,
      unitsPerBox: 12,
      unitPrice: 30,
      priceType: "MANUAL",
      overrideReason: "operator discount",
    };
    const incoming: MergeIncomingItem[] = [{ productId: "prod-dup", qty: 12, boxes: 1, pieces: 0 }];

    const { items } = foldMergeItems([first, second], incoming);

    // Both lines present after the fold — neither overwritten, neither dropped.
    expect(items).toHaveLength(2);
    // The first becomes 2 boxes (1 + the scanned 1) — the ONLY one touched.
    const grown = items.find((i) => i.boxes === 2 && i.unitPrice === undefined);
    expect(grown).toMatchObject({ productId: "prod-dup", boxes: 2, pieces: 0, qty: 24 });
    // The second survives byte-identical, including its MANUAL price and override reason —
    // never summed across duplicates, never dropped.
    const untouched = items.find((i) => i.unitPrice === 30);
    expect(untouched).toMatchObject({
      productId: "prod-dup",
      boxes: 2,
      pieces: 0,
      qty: 24,
      unitPrice: 30,
      overrideReason: "operator discount",
    });
  });

  it("SA-124g/h R1 item 3 (Opus HIGH): two PLAIN-product duplicate lines (no pack at all) fold a scan into the FIRST — NEVER a 409 naming empty packs", () => {
    // Two genuinely never-boxed lines of the same product — each its own bucket (MED-5), both
    // unitsPerBox 0 (unresolved). Pre-fix, this refused with existingPacks: [] ("at packs []").
    const first: MergeLineSnapshot = {
      productId: "prod-plain",
      qty: 5,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 2,
    };
    const second: MergeLineSnapshot = {
      productId: "prod-plain",
      qty: 3,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      unitPrice: 2,
    };
    const incoming: MergeIncomingItem[] = [{ productId: "prod-plain", qty: 4 }];

    const { items } = foldMergeItems([first, second], incoming);

    expect(items).toHaveLength(2);
    // The first grows by the scanned 4 pieces; the second survives byte-identical.
    const grown = items.find((i) => i.qty === 9);
    expect(grown).toMatchObject({ productId: "prod-plain", qty: 9 });
    const untouched = items.find((i) => i.qty === 3);
    expect(untouched).toMatchObject({ productId: "prod-plain", qty: 3 });
  });

  const boxedBucket: MergeLineSnapshot = {
    productId: "prod-mixed",
    boxes: 1,
    pieces: 0,
    qty: 12,
    unitsPerBox: 12,
    unitPrice: 36,
  };
  const plainBucket: MergeLineSnapshot = {
    productId: "prod-mixed",
    qty: 3,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 2,
  };
  const sixPackIncoming: MergeIncomingItem[] = [
    { productId: "prod-mixed", qty: 6, boxes: 1, pieces: 0 },
  ];

  it("SA-124i (mixed-bucket fix): [12-pack, plain] + a mismatched 6-pack scan REFUSES — ONE known pack among the buckets is still a genuine disagreement", () => {
    expect(() => foldMergeItems([boxedBucket, plainBucket], sixPackIncoming)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: "MERGE_PACK_MISMATCH",
          productId: "prod-mixed",
          existingPacks: [12],
          incomingPack: 6,
        }),
      }),
    );
  });

  it("SA-124i (mixed-bucket fix): [plain, 12-pack] + a mismatched 6-pack scan REFUSES — same as above, bucket order reversed", () => {
    expect(() => foldMergeItems([plainBucket, boxedBucket], sixPackIncoming)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: "MERGE_PACK_MISMATCH",
          existingPacks: [12],
          incomingPack: 6,
        }),
      }),
    );
  });

  it("SA-124i (mixed-bucket fix): [plain, plain] + a KNOWN-pack 6-pack scan still folds — no bucket has any known pack to disagree with", () => {
    const secondPlain: MergeLineSnapshot = { ...plainBucket, qty: 5 };
    const { items } = foldMergeItems([plainBucket, secondPlain], sixPackIncoming);

    expect(items).toHaveLength(2);
    // The first bucket (plain, qty 3) adopts the incoming's pack (6, since its own was
    // unresolved — foldInto's normal "fill in an unresolved pack" behavior, not a
    // disagreement) and normalizes: 1 box of 6 + the 3 pre-existing loose pieces = qty 9.
    const grown = items.find((i) => i.qty === 9);
    expect(grown).toMatchObject({ productId: "prod-mixed", boxes: 1, pieces: 3, qty: 9 });
    const untouched = items.find((i) => i.qty === 5);
    expect(untouched).toMatchObject({ productId: "prod-mixed", qty: 5 });
  });
});
