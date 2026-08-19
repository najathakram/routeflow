/**
 * Substitution PRODUCER pin (B2/B3, 2026-08-19 boxed-substitution money fixes).
 *
 * These drive the REAL editor chain — the substitute handler's row builder
 * (`buildSubstituteLine`), then `save()`'s draft → DiffCatalogLine mapping,
 * then `buildOrderItemDiff` — because pinning the payload builder alone proves
 * nothing about whether the editor ever hands it a box split or a divergent
 * price. Both silent overcharges lived in the producer, not the builder.
 */
import { buildSubstituteLine, type SubstitutedLine } from "../lib/substitute-line";
import {
  buildOrderItemDiff,
  type DiffCatalogLine,
  type OriginalLine,
} from "../lib/order-item-diff";
import { computeLineSubtotal, effectiveQty } from "../lib/pricing";

/** The editor's draft row: what buildSubstituteLine returns, plus modal edits. */
type DraftRow = SubstitutedLine & { overrideReason?: string };

/** Verbatim mirror of edit-items.tsx `save()`'s draft → DiffCatalogLine map. */
const toCatalogLine = (i: DraftRow): DiffCatalogLine => ({
  lineId: i.lineId,
  productId: i.productId,
  qty: effectiveQty(i, i.unitsPerBox),
  boxes: i.boxes ?? null,
  pieces: i.pieces ?? null,
  boxSplit: !!i.boxSplit,
  unitPrice: i.unitPrice,
  basePrice: i.catalogPrice,
  overrideReason: i.overrideReason,
  substituteProductId: i.substituteProductId,
});

/** The saved line being substituted away from (product P1). */
const ORIGINAL: OriginalLine = { id: "L1", productId: "P1", qty: 24, unitPrice: 30, name: null };

const payloadFor = (row: DraftRow, originals: OriginalLine[] = [ORIGINAL]) =>
  buildOrderItemDiff({
    catalog: [toCatalogLine(row)],
    unlisted: [],
    originals,
    pendingDeletes: [],
    pendingCancels: [],
  });

/** The substitute: a 12-pack listed at $30 a case. */
const TWELVE_PACK = { id: "P2", name: "Cola 12", unit: "case", unitsPerBox: 12 };

describe("buildSubstituteLine", () => {
  it("B2: re-denominates the ordered pieces against the SUBSTITUTE's box size", () => {
    // One case of a 24-pack (24 pieces) swapped onto a 12-pack = 2 cases.
    const row = buildSubstituteLine({
      previous: { qty: 24, boxes: 1, pieces: 0, unitsPerBox: 24, lineId: "L1" },
      product: TWELVE_PACK,
      tierPrice: 30,
      listPrice: 30,
    });
    expect(row).toMatchObject({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, boxSplit: true });
    expect(payloadFor(row)).toEqual([
      { id: "L1", substituteProductId: "P2", qty: 24, boxes: 2, pieces: 0 },
    ]);
    // 2 cases at $30 — the pre-fix payload (bare qty 24) billed 24 × $30.
    expect(
      computeLineSubtotal({
        unitPrice: row.unitPrice,
        qty: row.qty,
        boxes: row.boxes,
        pieces: row.pieces,
        unitsPerBox: row.unitsPerBox,
      }),
    ).toBe(60);
  });

  it("carries a loose remainder across the swap", () => {
    // 1 case + 5 loose of a 24-pack = 29 pieces → 2 cases + 5 loose of a 12-pack.
    const row = buildSubstituteLine({
      previous: { qty: 29, boxes: 1, pieces: 5, unitsPerBox: 24, lineId: "L1" },
      product: TWELVE_PACK,
      tierPrice: 30,
      listPrice: 30,
    });
    expect(row).toMatchObject({ qty: 29, boxes: 2, pieces: 5 });
    expect(payloadFor(row)).toEqual([
      { id: "L1", substituteProductId: "P2", qty: 29, boxes: 2, pieces: 5 },
    ]);
  });

  it("expands a box-UNAWARE line's selling-unit qty before re-splitting", () => {
    // A line created box-unaware stores qty as a BOX count with no split
    // (2 cases of a 24-pack = qty 2). Reading that 2 as pieces would bill
    // 2/12 of a case; it is 48 pieces = 4 cases of the 12-pack.
    const row = buildSubstituteLine({
      previous: { qty: 2, unitsPerBox: 24, lineId: "L1" },
      product: TWELVE_PACK,
      tierPrice: 30,
      listPrice: 30,
    });
    expect(row).toMatchObject({ qty: 48, boxes: 4, pieces: 0 });
    expect(payloadFor(row)).toEqual([
      { id: "L1", substituteProductId: "P2", qty: 48, boxes: 4, pieces: 0 },
    ]);
  });

  it("splits a LOOSE line's qty when the substitute is case-packed", () => {
    const row = buildSubstituteLine({
      previous: { qty: 24, unitsPerBox: null, lineId: "L1" },
      product: TWELVE_PACK,
      tierPrice: 30,
      listPrice: 30,
    });
    expect(row).toMatchObject({ qty: 24, boxes: 2, pieces: 0, boxSplit: true });
  });

  it("sends NO split when the substitute is sold loose", () => {
    const row = buildSubstituteLine({
      previous: { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, lineId: "L1" },
      product: { id: "P3", name: "Loose bar", unitsPerBox: null },
      tierPrice: 2,
      listPrice: 2,
    });
    expect(row).toMatchObject({ qty: 24, boxSplit: false });
    expect(row.boxes).toBeUndefined();
    expect(payloadFor(row)).toEqual([{ id: "L1", substituteProductId: "P3", qty: 24 }]);
  });

  it("B3: the customer's TIER price reaches the wire (it diverges from list)", () => {
    const row = buildSubstituteLine({
      previous: { qty: 24, boxes: 1, pieces: 0, unitsPerBox: 24, lineId: "L1" },
      product: TWELVE_PACK,
      tierPrice: 24,
      listPrice: 30,
    });
    // The card shows $24 — so must the payload, or the server bills list ($30).
    expect(payloadFor(row)).toEqual([
      { id: "L1", substituteProductId: "P2", qty: 24, boxes: 2, pieces: 0, unitPrice: 24 },
    ]);
  });

  it("sends NO unitPrice at the substitute's list price (tier 1)", () => {
    const row = buildSubstituteLine({
      previous: { qty: 24, boxes: 1, pieces: 0, unitsPerBox: 24, lineId: "L1" },
      product: TWELVE_PACK,
      tierPrice: 30,
      listPrice: 30,
    });
    expect(payloadFor(row)).toEqual([
      { id: "L1", substituteProductId: "P2", qty: 24, boxes: 2, pieces: 0 },
    ]);
  });

  it("B3: an override typed after the swap carries its price + reason", () => {
    const row = buildSubstituteLine({
      previous: { qty: 24, boxes: 1, pieces: 0, unitsPerBox: 24, lineId: "L1" },
      product: TWELVE_PACK,
      tierPrice: 30,
      listPrice: 30,
    });
    // PriceOverrideModal's onSave spreads the row and sets price + reason.
    const edited: DraftRow = { ...row, unitPrice: 20, overrideReason: "bulk deal" };
    expect(payloadFor(edited)).toEqual([
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

  it("a row added THIS session re-picks as a new line, still box-split", () => {
    // No lineId → no substitution marker; the diff's new-catalog-line branch
    // must still carry the split or the server bills case price × pieces.
    const row = buildSubstituteLine({
      previous: { qty: 24, boxes: 1, pieces: 0, unitsPerBox: 24 },
      product: TWELVE_PACK,
      tierPrice: 30,
      listPrice: 30,
    });
    expect(row.substituteProductId).toBeUndefined();
    expect(payloadFor(row, [])).toEqual([{ productId: "P2", qty: 24, boxes: 2, pieces: 0 }]);
  });
});
