import { legacyLinePieces } from "@routeflow/pricing";

/**
 * ONE place that turns an order line's `qty` into pieces per line unit, for every writer that has to compare
 * or add a quantity counted in PIECES with a quantity counted in the line's own unit (B665 standard-return restock). The classifier itself is `legacyLinePieces` (`@routeflow/pricing`, one import, Senior Architect
 * ruling 2026-09-21); this is only the glue that finds its evidence, so the two writers can never drift apart.
 *
 * A line needs the classifier when it has NO split and a pack exists (its own snapshot > 1, or the live pack
 * > 1: the live product is only a TRIGGER here, never a factor). Lines with a split, and products with no
 * pack, are factor 1 and are absent from the result.
 *
 * SOURCE: the line's OWN linked InvoiceItem, and only when the line has EXACTLY ONE of them. `relation:
 * "full"` tells the classifier the line is a whole 1:1 copy of that item, which is what unlocks the
 * box-count inference (`line.qty === source.boxes` => the qty counted BOXES). That claim holds only for a
 * single, whole billing. A line billed across SEVERAL invoice items is a PARTIAL against each of them,
 * where a coincidental `qty === boxes` is a known false positive, so more than one candidate is `unknown`
 * and the line PARKS. Deciding on the COUNT also removes the non-determinism of picking "one of them":
 * the arbitrary row order of an unordered query can no longer change the answer for identical data.
 *
 * No InvoiceItem, one with no split, or more than one, is unknown — it PARKS, never a sibling guess and
 * never a guess from the live product.
 */
export type PackFactor = { factor: number } | { unknown: true; reason: string };

export interface PackLine {
  id: string;
  productId: string | null;
  qty: unknown;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /** units_v1: a non-blank label marks a unit-aware line, whose stored qty is already base pieces. */
  unitLabel?: string | null;
  product?: { unitsPerBox?: number | null } | null;
}

const hasSplit = (x: any): boolean => !!x && (x.boxes != null || x.pieces != null);

/**
 * B802: a unit-aware line already counts base pieces — a factor-1 unit keeps no split and snapshots
 * unitsPerBox 1, a factor > 1 unit stores a boxes/pieces split (`unit-line-build.ts`) — so it is factor 1,
 * as `regulatedUnitBasis`'s branch 1 reads it. Without this a factor-1 unit line on a boxed product was
 * sent to the classifier on the live pack alone and parked as unknown. The label alone is not trusted:
 * an order edit that moves a unit line back to the pack leaves the label behind on a box-count line, so
 * only the exact shape the unit writers produce (label AND snapshot 1; split lines are skipped anyway)
 * short-circuits — anything else still resolves through its InvoiceItem or parks.
 */
const isUnitAware = (li: PackLine): boolean =>
  (li.unitLabel ?? "").trim() !== "" && Number(li.unitsPerBox ?? 0) === 1;

export const needsPackResolution = (li: PackLine): boolean =>
  !isUnitAware(li) &&
  !hasSplit(li) &&
  (Number(li.unitsPerBox ?? 0) > 1 || Number(li.product?.unitsPerBox ?? 0) > 1);

const asLegacy = (x: any) => ({
  qty: Number(x.qty),
  boxes: x.boxes ?? null,
  pieces: x.pieces ?? null,
  unitsPerBox: x.unitsPerBox ?? null,
});

export async function resolvePackFactors(args: {
  orderId: string;
  lines: PackLine[];
  /**
   * Line id -> EVERY live InvoiceItem billed from it (qty, boxes, pieces, unitsPerBox), for the ambiguous
   * lines. The loader returns all of them and never a pre-picked one: the COUNT is what decides whether a
   * 1:1 `relation: "full"` source exists at all, so a loader that collapsed duplicates would hide exactly
   * the case this has to refuse. Items on VOID invoices are not live billings — the loader excludes them.
   */
  loadInvoiceItems: (lineIds: string[]) => Promise<Map<string, any[]>>;
}): Promise<Map<string, PackFactor>> {
  const out = new Map<string, PackFactor>();
  const ambiguous = args.lines.filter(needsPackResolution);
  if (ambiguous.length === 0) return out;
  const invByLine = await args.loadInvoiceItems(ambiguous.map((li) => li.id));
  for (const li of ambiguous) {
    const candidates = invByLine.get(li.id) ?? [];
    if (candidates.length > 1) {
      // Billed across several invoice items: none of them is a whole 1:1 copy of the line, so the
      // box-count inference `relation: "full"` unlocks would be reading a coincidence as evidence.
      out.set(li.id, {
        unknown: true,
        reason: `the order line was billed across ${candidates.length} invoice items, so none of them is a 1:1 source for its pack`,
      });
      continue;
    }
    const inv = candidates[0];
    const source = hasSplit(inv) ? inv : null;
    // relation "full": an order line is the 1:1 copy of its OWN InvoiceItem — a sibling line is never a
    // source (Senior Architect ruling 2026-09-21).
    //
    // productPackNow is a GATE ("is this product boxed at all today"), never a multiplier, and it is
    // supplied ONLY when the line's OWN snapshot does not already answer what the gate asks. A line whose
    // `unitsPerBox > 1` carries a sale-time snapshot of the PRODUCT's box size, so the product WAS packed
    // when this line sold; a product with no box size TODAY therefore means the pack CHANGED after the
    // sale, which is precisely the case the live product must not decide. Handing it over would fire the
    // classifier's "non-boxed-now"
    // fallback and read 3 boxes as 3 pieces — restocking 12x short, the exact defect B665 fixes. Omitting
    // it only loses that fallback and can never produce a wrong answer (see the classifier's header): the
    // line is `unknown` and the item parks. A missing product row is omitted for the same reason.
    const snapshotProvesBoxedAtSale = Number(li.unitsPerBox ?? 0) > 1;
    const res = legacyLinePieces(asLegacy(li), source && asLegacy(source), {
      relation: "full",
      ...(li.product && !snapshotProvesBoxedAtSale
        ? { productPackNow: li.product.unitsPerBox ?? null }
        : {}),
    });
    if ("unknown" in res) {
      out.set(li.id, { unknown: true, reason: res.reason });
      continue;
    }
    const qty = Number(li.qty);
    if (!(qty > 0)) {
      // A zero or negative qty has no factor to derive. Recording NOTHING would be read back by the
      // restock resolver as factor 1, which then outvotes a real sibling line's factor and parks the whole
      // product; an explicit unknown keeps the reason honest and the outcome the same for this line alone.
      out.set(li.id, {
        unknown: true,
        reason: "the order line has no positive qty to derive a pack from",
      });
      continue;
    }
    const factor = res.pieces / qty;
    if (!Number.isInteger(factor) || factor < 1) {
      // A pack is a whole number of pieces per line unit. A fractional factor means the SOURCE row is
      // internally inconsistent (its qty is not boxes * pack + pieces), and multiplying a return by it
      // books a fractional stock movement or a fractional reversal. Refuse rather than write that.
      out.set(li.id, {
        unknown: true,
        reason: `the pack derived from the source (${res.pieces} pieces over ${qty}) is not a whole number of pieces per unit`,
      });
      continue;
    }
    out.set(li.id, { factor });
  }
  return out;
}
