/**
 * Incremental order-item diff: only changed/added/removed lines are emitted,
 * each with its DB id + action, so untouched lines (and their invoiced qty +
 * override history) survive the server's replaceAll:false merge.
 */
import {
  buildOrderItemDiff,
  type DiffCatalogLine,
  type DiffUnlistedLine,
  type OriginalLine,
} from "../lib/order-item-diff";

const origLine = (o: Partial<OriginalLine>): OriginalLine => ({
  id: "L1",
  productId: "P1",
  qty: 10,
  unitPrice: 5,
  name: null,
  ...o,
});

const cat = (c: Partial<DiffCatalogLine>): DiffCatalogLine => ({
  productId: "P1",
  qty: 10,
  boxSplit: false,
  unitPrice: 5,
  basePrice: 5,
  ...c,
});

function run(args: {
  catalog?: DiffCatalogLine[];
  unlisted?: DiffUnlistedLine[];
  originals?: OriginalLine[];
  pendingDeletes?: string[];
  pendingCancels?: string[];
}) {
  return buildOrderItemDiff({
    catalog: args.catalog ?? [],
    unlisted: args.unlisted ?? [],
    originals: args.originals ?? [],
    pendingDeletes: args.pendingDeletes ?? [],
    pendingCancels: args.pendingCancels ?? [],
  });
}

describe("buildOrderItemDiff", () => {
  it("emits NOTHING for an untouched existing line (the whole point)", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 5 })],
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 5 })],
    });
    expect(out).toEqual([]);
  });

  it("REG-MSCAN-M1: emits NOTHING for an untouched line that already carries a saved overrideReason", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 4, overrideReason: "deal" })],
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 4, overrideReason: "deal" })],
    });
    expect(out).toEqual([]);
  });

  it("UPDATE carries qty when only qty changed (no unitPrice)", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 12, unitPrice: 5 })],
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 5 })],
    });
    expect(out).toEqual([{ id: "L1", action: "UPDATE", qty: 12 }]);
  });

  it("UPDATE carries qty + unitPrice when the price changed", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 4, overrideReason: "deal" })],
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 5 })],
    });
    expect(out).toEqual([
      { id: "L1", action: "UPDATE", qty: 10, unitPrice: 4, overrideReason: "deal" },
    ]);
  });

  it("REG-MSCAN-M1: a reason-only edit is not dropped — overrideReason changes with price and qty unchanged", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 4, overrideReason: "corrected reason" })],
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 4, overrideReason: "deal" })],
    });
    // Wrong-today value: buildOrderItemDiff emits overrideReason only inside the
    // priceChanged branch, so a reason-only correction (unitPrice identical to the
    // original) currently emits [] — the UI shows the corrected reason as saved,
    // but reload reverts to the stale one.
    expect(out).toEqual([
      { id: "L1", action: "UPDATE", qty: 10, overrideReason: "corrected reason" },
    ]);
  });

  it("F3: a reason-only edit sends NO unitPrice — R9's server-side isManualOverride must not be re-derived off an echoed price", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 4, overrideReason: "second look" })],
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 4, overrideReason: "deal" })],
    });
    expect(out).toEqual([{ id: "L1", action: "UPDATE", qty: 10, overrideReason: "second look" }]);
    expect(out[0]).not.toHaveProperty("unitPrice");
  });

  it("F2: clearing a reason sends overrideReason as an explicit empty string, never omitted", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 4, overrideReason: undefined })],
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 4, overrideReason: "deal" })],
    });
    expect(out).toEqual([{ id: "L1", action: "UPDATE", qty: 10, overrideReason: "" }]);
  });

  it("B465: a price-only edit STILL carries the line's already-stored (unchanged) reason — the server refuses a special-price change with no reason on the wire to fall back to", () => {
    // Draft state seeds overrideReason from the original line (edit-items.tsx),
    // so a genuine price edit that never touches the reason field arrives here
    // with catalog.overrideReason === originals.overrideReason — reasonChanged
    // is false, but the reason must still ride along with the price. Before
    // this fix, overrideReason was gated on reasonChanged ALONE, so this exact
    // shape sent unitPrice with no overrideReason at all.
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 8, overrideReason: "manager approved" })],
      originals: [
        origLine({ id: "L1", qty: 10, unitPrice: 10, overrideReason: "manager approved" }),
      ],
    });
    expect(out).toEqual([
      { id: "L1", action: "UPDATE", qty: 10, unitPrice: 8, overrideReason: "manager approved" },
    ]);
  });

  it("new catalog line at the tier base sends NO unitPrice", () => {
    const out = run({ catalog: [cat({ productId: "P9", qty: 3, unitPrice: 5, basePrice: 5 })] });
    expect(out).toEqual([{ productId: "P9", qty: 3 }]);
  });

  it("new catalog line below the tier base sends the override", () => {
    const out = run({ catalog: [cat({ productId: "P9", qty: 3, unitPrice: 4, basePrice: 5 })] });
    expect(out).toEqual([{ productId: "P9", qty: 3, unitPrice: 4 }]);
  });

  it("box-split line sends boxes/pieces; a flat line does not", () => {
    const split = run({
      catalog: [cat({ productId: "P9", qty: 24, boxSplit: true, boxes: 2, pieces: 0 })],
    });
    expect(split[0]).toMatchObject({ productId: "P9", qty: 24, boxes: 2, pieces: 0 });
    const flat = run({ catalog: [cat({ productId: "P9", qty: 24, boxSplit: false })] });
    expect(flat[0]).toEqual({ productId: "P9", qty: 24 });
  });

  it("substitution emits {id, substituteProductId, qty}", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", productId: "P2", substituteProductId: "P2", qty: 10 })],
      originals: [origLine({ id: "L1", productId: "P1" })],
    });
    expect(out).toEqual([{ id: "L1", substituteProductId: "P2", qty: 10 }]);
  });

  // ── B1/B2/B3 regression pins (2026-08-19 boxed/substitution money fixes) ──

  it("B1: a fresh boxed add (1 case, boxSplit true) emits boxes/pieces", () => {
    const out = run({
      catalog: [
        cat({
          productId: "P9",
          qty: 12,
          boxes: 1,
          pieces: 0,
          boxSplit: true,
          unitPrice: 24,
          basePrice: 24,
        }),
      ],
    });
    expect(out).toEqual([{ productId: "P9", qty: 12, boxes: 1, pieces: 0 }]);
  });

  it("B2: a boxed substitution (2 cases of 12 = qty 24) emits {boxes: 2, pieces: 0}", () => {
    const out = run({
      catalog: [
        cat({
          lineId: "L1",
          productId: "P2",
          substituteProductId: "P2",
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitPrice: 24, // substitute's own list price — nothing to send
          basePrice: 24,
        }),
      ],
      originals: [origLine({ id: "L1", productId: "P1", qty: 24, unitPrice: 24 })],
    });
    expect(out).toEqual([{ id: "L1", substituteProductId: "P2", qty: 24, boxes: 2, pieces: 0 }]);
  });

  it("B3: a substitution with an operator override emits unitPrice + overrideReason", () => {
    const out = run({
      catalog: [
        cat({
          lineId: "L1",
          productId: "P2",
          substituteProductId: "P2",
          qty: 24,
          boxes: 2,
          pieces: 0,
          unitPrice: 20,
          basePrice: 24, // substitute's list price — 20 diverges from it
          overrideReason: "bulk deal",
        }),
      ],
      originals: [origLine({ id: "L1", productId: "P1", qty: 24, unitPrice: 24 })],
    });
    expect(out).toEqual([
      {
        id: "L1",
        substituteProductId: "P2",
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitPrice: 20,
        overrideReason: "bulk deal",
      },
    ]);
  });

  it("a substitution AT the substitute's list price sends NO unitPrice (even if the original line priced differently)", () => {
    const out = run({
      catalog: [
        cat({
          lineId: "L1",
          productId: "P2",
          substituteProductId: "P2",
          qty: 10,
          unitPrice: 7,
          basePrice: 7, // substitute's own list price
        }),
      ],
      originals: [origLine({ id: "L1", productId: "P1", qty: 10, unitPrice: 5 })],
    });
    expect(out).toEqual([{ id: "L1", substituteProductId: "P2", qty: 10 }]);
  });

  it("a plain qty line still emits no boxes/pieces (the data-presence gate doesn't leak)", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 12, unitPrice: 5 })],
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 5 })],
    });
    expect(out).toEqual([{ id: "L1", action: "UPDATE", qty: 12 }]);
  });

  it("trash → DELETE, not-available → CANCEL", () => {
    const out = run({ pendingDeletes: ["L1"], pendingCancels: ["L2"] });
    expect(out).toEqual([
      { id: "L1", action: "DELETE" },
      { id: "L2", action: "CANCEL" },
    ]);
  });

  it("new unlisted → {name,qty,unitPrice}; existing changed → {id,...}; unchanged → nothing", () => {
    const out = run({
      unlisted: [
        { name: "Pallet fee", qty: 1, unitPrice: 20 }, // new
        { lineId: "U1", name: "Ice", qty: 4, unitPrice: 2 }, // qty changed 2→4
        { lineId: "U2", name: "Bag", qty: 1, unitPrice: 1 }, // unchanged
      ],
      originals: [
        origLine({ id: "U1", productId: null, name: "Ice", qty: 2, unitPrice: 2 }),
        origLine({ id: "U2", productId: null, name: "Bag", qty: 1, unitPrice: 1 }),
      ],
    });
    expect(out).toEqual([
      { name: "Pallet fee", qty: 1, unitPrice: 20 },
      { id: "U1", qty: 4 },
    ]);
  });

  it("a rename of an existing unlisted line carries the new name", () => {
    const out = run({
      unlisted: [{ lineId: "U1", name: "Delivery surcharge", qty: 1, unitPrice: 10 }],
      originals: [origLine({ id: "U1", productId: null, name: "Delivery", qty: 1, unitPrice: 10 })],
    });
    expect(out).toEqual([{ id: "U1", qty: 1, name: "Delivery surcharge" }]);
  });

  it("auto-DELETEs an existing line the operator zeroed (dropped from draft, no trash)", () => {
    // The zeroed line L2 is simply absent from `catalog`; L1 survives untouched.
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 5 })],
      originals: [
        origLine({ id: "L1", qty: 10, unitPrice: 5 }),
        origLine({ id: "L2", productId: "P2", qty: 4, unitPrice: 3 }),
      ],
    });
    expect(out).toEqual([{ id: "L2", action: "DELETE" }]);
  });

  it("does not double-emit DELETE when a dropped line is also in pendingDeletes", () => {
    const out = run({
      catalog: [],
      originals: [origLine({ id: "L1" })],
      pendingDeletes: ["L1"],
    });
    expect(out).toEqual([{ id: "L1", action: "DELETE" }]);
  });

  it("does not DELETE a dropped line already marked CANCEL", () => {
    const out = run({
      catalog: [],
      originals: [origLine({ id: "L1" })],
      pendingCancels: ["L1"],
    });
    expect(out).toEqual([{ id: "L1", action: "CANCEL" }]);
  });

  it("B805 (Opus N1): a pendingDelete whose id is ALSO a surviving catalog line sends the line's own UPDATE only — never a DELETE alongside it", () => {
    // The exact race: trash L1 (queues pendingDeletes: ["L1"]), then re-add
    // the same product in the same batch — the draft record is keyed by
    // lineId, so a rescan/reopened price-edit can repopulate draft["L1"]
    // AFTER the trash click already queued "L1" here.
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 7, unitPrice: 5 })], // qty changed 10 -> 7
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 5 })],
      pendingDeletes: ["L1"],
    });
    expect(out).toEqual([{ id: "L1", action: "UPDATE", qty: 7 }]);
  });

  it("B805: the surviving line's own UNCHANGED state emits NOTHING (not a DELETE) when its id is also a stale pendingDelete", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 5 })], // byte-identical to original
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 5 })],
      pendingDeletes: ["L1"],
    });
    expect(out).toEqual([]);
  });

  it("B805: the same protection applies to pendingCancels — a surviving line's id is dropped from cancels, never CANCELled alongside its own UPDATE", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 3, unitPrice: 5 })],
      originals: [origLine({ id: "L1", qty: 10, unitPrice: 5 })],
      pendingCancels: ["L1"],
    });
    expect(out).toEqual([{ id: "L1", action: "UPDATE", qty: 3 }]);
  });

  it("B805: a DIFFERENT line's own pendingDelete is unaffected by an unrelated surviving line", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 10, unitPrice: 5 })], // L1 survives untouched
      originals: [
        origLine({ id: "L1", qty: 10, unitPrice: 5 }),
        origLine({ id: "L2", productId: "P2", qty: 4, unitPrice: 3 }),
      ],
      pendingDeletes: ["L2"], // L2 was trashed and never came back
    });
    expect(out).toEqual([{ id: "L2", action: "DELETE" }]);
  });

  it("auto-DELETEs a zeroed existing UNLISTED line too", () => {
    const out = run({
      unlisted: [], // U1 was zeroed away
      originals: [origLine({ id: "U1", productId: null, name: "Ice", qty: 2, unitPrice: 2 })],
    });
    expect(out).toEqual([{ id: "U1", action: "DELETE" }]);
  });

  it("skips zero-qty and blank-name lines", () => {
    const out = run({
      catalog: [cat({ productId: "P9", qty: 0 })],
      unlisted: [{ name: "  ", qty: 3, unitPrice: 5 }],
    });
    expect(out).toEqual([]);
  });

  // ── B707: a unit-aware line's UPDATE wire shape diverges from a pack line's ──

  it("B707: a unit-aware line's UPDATE sends {id, qty: <unit count>, unitLabel, productId}, never boxFields or the piece-expanded qty", () => {
    const out = run({
      catalog: [
        cat({
          lineId: "L1",
          qty: 1152, // piece-expanded total (4 cases * 288) — must NOT reach the wire
          boxes: 4,
          pieces: 0,
          unitPrice: 20,
          basePrice: 20,
          unitLabel: "Case",
        }),
      ],
      originals: [origLine({ id: "L1", qty: 864, unitPrice: 20 })], // was 3 cases
    });
    // productId rides along with unitLabel (mobile unit picker): prepareUnitEditContext only
    // preloads the product/ladder for this item when the item itself carries productId or the
    // STORED line already has a unitLabel — a filed, unfixed server gap this closes for the
    // client's own payload regardless of which case applies.
    expect(out).toEqual([
      { id: "L1", action: "UPDATE", qty: 4, unitLabel: "Case", productId: "P1" },
    ]);
    expect(out[0]).not.toHaveProperty("boxes");
    expect(out[0]).not.toHaveProperty("pieces");
  });

  it("B707: an untouched unit-aware line emits NOTHING (unitsPerBox already correct upstream keeps the piece-total comparison stable)", () => {
    const out = run({
      catalog: [
        cat({
          lineId: "L1",
          qty: 864,
          boxes: 3,
          pieces: 0,
          unitPrice: 20,
          basePrice: 20,
          unitLabel: "Case",
        }),
      ],
      originals: [origLine({ id: "L1", qty: 864, unitPrice: 20 })],
    });
    expect(out).toEqual([]);
  });

  it("B707: a factor-1 unit line (no box split, count IS qty) sends {id, qty: <count>, unitLabel} on a price-only edit", () => {
    const out = run({
      catalog: [
        cat({
          lineId: "L1",
          qty: 5, // 5 Pieces, no boxes/pieces split stored (factor 1)
          unitPrice: 9,
          basePrice: 9,
          unitLabel: "Piece",
        }),
      ],
      originals: [origLine({ id: "L1", qty: 5, unitPrice: 8 })],
    });
    // overrideReason "" rides along per the pre-existing B465 rule (reason
    // travels WITH any price change) — unrelated to units, unchanged by this fix.
    expect(out).toEqual([
      {
        id: "L1",
        action: "UPDATE",
        qty: 5,
        unitLabel: "Piece",
        productId: "P1",
        unitPrice: 9,
        overrideReason: "",
      },
    ]);
  });

  it("B707: a pack line (no unitLabel) is completely unaffected — still sends boxFields, never unitLabel", () => {
    const out = run({
      catalog: [cat({ lineId: "L1", qty: 24, boxes: 2, pieces: 0, unitPrice: 5 })],
      originals: [origLine({ id: "L1", qty: 12, unitPrice: 5 })],
    });
    expect(out).toEqual([{ id: "L1", action: "UPDATE", qty: 24, boxes: 2, pieces: 0 }]);
    expect(out[0]).not.toHaveProperty("unitLabel");
  });

  // ── B718: a unit-aware UPDATE must never send qty:0 (the API's @Min(1) refuses the WHOLE
  // multi-line save, not just this line) ──────────────────────────────────────────────────

  it("B718: a unit-aware line with a MEANINGLESS boxes:0 (the fresh-piece-scan leftover shape) still sends the real positive qty, never 0", () => {
    // boxes:0/pieces:1 is exactly what applyPickToDraft (edit-items-draft.ts) leaves on a line
    // scanned by its piece code BEFORE any unit was picked for it — if a unit gets picked
    // without boxes/pieces ever normalizing away, `line.boxes ?? line.qty` would read the
    // MEANINGLESS 0 as "the count", not the real qty.
    const out = run({
      catalog: [
        cat({
          lineId: "L1",
          qty: 3, // the real unit count (3 Cases)
          boxes: 0, // meaningless leftover — must NOT be read as "0 Cases"
          pieces: 1,
          unitPrice: 20,
          basePrice: 20,
          unitLabel: "Case",
        }),
      ],
      originals: [origLine({ id: "L1", qty: 2, unitPrice: 20 })], // was 2 cases -> now 3
    });
    expect(out).toEqual([
      { id: "L1", action: "UPDATE", qty: 3, unitLabel: "Case", productId: "P1" },
    ]);
    const qty = (out[0] as { qty: number }).qty;
    expect(qty).toBeGreaterThan(0);
  });

  it("B718: a genuinely positive boxes count (the pack-piece storage shape, B707) is still preferred over qty — no regression from the boxes:0 fix", () => {
    const out = run({
      catalog: [
        cat({
          lineId: "L1",
          qty: 1152, // piece-expanded total (4 cases * 288) — must NOT reach the wire
          boxes: 4,
          pieces: 0,
          unitPrice: 20,
          basePrice: 20,
          unitLabel: "Case",
        }),
      ],
      originals: [origLine({ id: "L1", qty: 864, unitPrice: 20 })],
    });
    expect(out).toEqual([
      { id: "L1", action: "UPDATE", qty: 4, unitLabel: "Case", productId: "P1" },
    ]);
  });

  it("B718 (property check): no UPDATE this function emits ever carries qty <= 0, across every unitLabel/boxes/pieces combination that survives the qty<=0 guard", () => {
    const combos: Array<Partial<DiffCatalogLine>> = [
      { unitLabel: "Case", qty: 5, boxes: 0, pieces: 0 },
      { unitLabel: "Case", qty: 5, boxes: 0, pieces: null },
      { unitLabel: "Case", qty: 5, boxes: null, pieces: 0 },
      { unitLabel: "Case", qty: 2, boxes: 2, pieces: 0 },
      { unitLabel: null, qty: 5, boxes: 0, pieces: 3 },
    ];
    for (const c of combos) {
      const out = run({
        catalog: [cat({ lineId: "L1", unitPrice: 20, basePrice: 20, ...c })],
        originals: [origLine({ id: "L1", qty: 1, unitPrice: 999 })], // force a change every time
      });
      for (const entry of out) {
        if ("qty" in entry) expect((entry as { qty: number }).qty).toBeGreaterThan(0);
      }
    }
  });

  // ── units_v1 (mobile unit picker): originating a brand-new unit-sold line ──

  it("a NEW catalog line sold by a unit sends {productId, qty: <count>, unitLabel}, never boxFields", () => {
    const out = run({
      catalog: [
        cat({
          productId: "P9",
          qty: 3, // the unit COUNT — never expanded to base pieces
          unitPrice: 220,
          basePrice: 220, // the unit's OWN resolved price — untouched, so no override
          unitLabel: "Case",
        }),
      ],
    });
    expect(out).toEqual([{ productId: "P9", qty: 3, unitLabel: "Case" }]);
    expect(out[0]).not.toHaveProperty("boxes");
    expect(out[0]).not.toHaveProperty("pieces");
  });

  it("a NEW unit-sold line with a genuine operator override still sends unitPrice", () => {
    const out = run({
      catalog: [
        cat({
          productId: "P9",
          qty: 3,
          unitPrice: 200, // typed below the unit's own resolved price (basePrice)
          basePrice: 220,
          unitLabel: "Case",
          overrideReason: "Bulk discount",
        }),
      ],
    });
    expect(out).toEqual([
      {
        productId: "P9",
        qty: 3,
        unitLabel: "Case",
        unitPrice: 200,
        overrideReason: "Bulk discount",
      },
    ]);
  });
});
