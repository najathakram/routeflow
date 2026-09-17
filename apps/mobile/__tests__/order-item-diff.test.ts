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
});
