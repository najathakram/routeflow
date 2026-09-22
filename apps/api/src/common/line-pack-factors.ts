import { legacyLinePieces } from "@routeflow/pricing";

/**
 * ONE place that turns an order line's `qty` into pieces per line unit, for every writer that has to compare
 * or add a quantity counted in PIECES with a quantity counted in the line's own unit (B665 standard-return restock). The classifier itself is `legacyLinePieces` (`@routeflow/pricing`, one import, Senior Architect
 * ruling 2026-09-21); this is only the glue that finds its evidence, so the two writers can never drift apart.
 *
 * A line needs the classifier when it has NO split and a pack exists (its own snapshot > 1, or the live pack
 * > 1: the live product is only a TRIGGER here, never a factor). Lines with a split, and products with no
 * pack, are factor 1 and are absent from the result. Source: the line's linked InvoiceItem only, when it
 * carries a split. No InvoiceItem, or one with no split, is unknown — it PARKS, never a sibling guess.
 */
export type PackFactor = { factor: number } | { unknown: true; reason: string };

export interface PackLine {
  id: string;
  productId: string | null;
  qty: unknown;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  product?: { unitsPerBox?: number | null } | null;
}

const hasSplit = (x: any): boolean => !!x && (x.boxes != null || x.pieces != null);

export const needsPackResolution = (li: PackLine): boolean =>
  !hasSplit(li) && (Number(li.unitsPerBox ?? 0) > 1 || Number(li.product?.unitsPerBox ?? 0) > 1);

const asLegacy = (x: any) => ({
  qty: Number(x.qty),
  boxes: x.boxes ?? null,
  pieces: x.pieces ?? null,
  unitsPerBox: x.unitsPerBox ?? null,
});

export async function resolvePackFactors(args: {
  orderId: string;
  lines: PackLine[];
  /** Line id -> the InvoiceItem billed from it (qty, boxes, pieces, unitsPerBox), for the ambiguous lines. */
  loadInvoiceItems: (lineIds: string[]) => Promise<Map<string, any>>;
}): Promise<Map<string, PackFactor>> {
  const out = new Map<string, PackFactor>();
  const ambiguous = args.lines.filter(needsPackResolution);
  if (ambiguous.length === 0) return out;
  const invByLine = await args.loadInvoiceItems(ambiguous.map((li) => li.id));
  for (const li of ambiguous) {
    const inv = invByLine.get(li.id);
    const source = hasSplit(inv) ? inv : null;
    // relation "full": an order line is the 1:1 copy of its OWN InvoiceItem — a sibling line is never a
    // source (Senior Architect ruling 2026-09-21).
    //
    // productPackNow is a GATE ("is this product boxed at all today"), never a multiplier, and it is
    // supplied ONLY when the line's OWN snapshot does not already prove it was boxed when it sold. A line
    // with `unitsPerBox > 1` and no split WAS boxed at sale time, so a product with no box size TODAY means
    // the pack CHANGED after the sale; handing that over would fire the classifier's "non-boxed-now"
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
    if ("unknown" in res) out.set(li.id, { unknown: true, reason: res.reason });
    else if (Number(li.qty) > 0) out.set(li.id, { factor: res.pieces / Number(li.qty) });
  }
  return out;
}
