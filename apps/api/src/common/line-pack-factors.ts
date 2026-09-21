import { legacyLinePieces } from "../regulated/legacy-line-pieces.stub"; // -> @routeflow/pricing when U-units lands it

/**
 * ONE place that turns an order line's `qty` into pieces per line unit, for every writer that has to compare
 * or add a quantity counted in PIECES with a quantity counted in the line's own unit (B660 ledger reversal,
 * B665 standard-return restock). The classifier itself is `legacyLinePieces` (one import, Senior Architect
 * ruling 2026-09-21); this is only the glue that finds its evidence, so the two writers can never drift apart.
 *
 * A line needs the classifier when it has NO split and a pack exists (its own snapshot > 1, or the live pack
 * > 1: the live product is only a TRIGGER here, never a factor). Lines with a split, and products with no
 * pack, are factor 1 and are absent from the result. Source precedence: the line's linked InvoiceItem when it
 * carries a split, then a same-product sibling order line with a split.
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

export async function resolvePackFactors(
  db: any,
  args: {
    orderId: string;
    lines: PackLine[];
    /** Line id -> the InvoiceItem billed from it (qty, boxes, pieces, unitsPerBox), for the ambiguous lines. */
    loadInvoiceItems: (lineIds: string[]) => Promise<Map<string, any>>;
  },
): Promise<Map<string, PackFactor>> {
  const out = new Map<string, PackFactor>();
  const ambiguous = args.lines.filter(needsPackResolution);
  if (ambiguous.length === 0) return out;
  const invByLine = await args.loadInvoiceItems(ambiguous.map((li) => li.id));
  const needSibling = ambiguous.filter((li) => !hasSplit(invByLine.get(li.id)));
  const siblings: any[] =
    needSibling.length > 0
      ? await db.orderItem.findMany({
          where: {
            orderId: args.orderId,
            productId: { in: [...new Set(needSibling.map((li) => li.productId))] },
            boxes: { not: null },
          },
          select: { productId: true, qty: true, boxes: true, pieces: true, unitsPerBox: true },
        })
      : [];
  for (const li of ambiguous) {
    const inv = invByLine.get(li.id);
    const sibling = siblings.find((x) => x.productId === li.productId);
    const source = hasSplit(inv) ? inv : (sibling ?? null);
    const res = legacyLinePieces(asLegacy(li), source && asLegacy(source));
    if ("unknown" in res) out.set(li.id, { unknown: true, reason: res.reason });
    else if (Number(li.qty) > 0) out.set(li.id, { factor: res.pieces / Number(li.qty) });
  }
  return out;
}
