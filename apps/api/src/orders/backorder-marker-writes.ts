import { backorderPiecesForEditDelta } from "./oversell-policy";
import { editMarkers, type EditMarkerLine } from "./backorder-marker";

/**
 * SA-714 R1 / SA-716: the DB half of the backorder marker. Called ONLY from inside the locked stock
 * section (order-stock.ts), in the caller's transaction, while the product rows are `FOR UPDATE`-held.
 * Informational: nothing here (or anywhere) reads `backorderedPieces` back for money, invoice,
 * stock or status decisions.
 */

/** Group `id -> value` writes into one `updateMany` per distinct value; unchanged rows are not rewritten. */
async function writeValues(db: any, values: Map<string, number>): Promise<void> {
  const byValue = new Map<number, string[]>();
  for (const [id, n] of values) byValue.set(n, [...(byValue.get(n) ?? []), id]);
  for (const [n, ids] of byValue) {
    await db.orderItem.updateMany({
      where: { id: { in: ids }, backorderedPieces: { not: n } },
      data: { backorderedPieces: n },
    });
  }
}

/**
 * SET at a fresh sale moment. A line that already has a row (`id`: promotion, template cron) is
 * written here, now; a line with no row yet (create) is handed back with its value so the caller's
 * nested create carries it. Only lines with a non-zero marker are handed back.
 */
export async function writeSaleMarkers<L extends { id?: string }>(
  db: any,
  markers: Map<L, number>,
): Promise<Map<L, number>> {
  const rows = new Map<string, number>();
  const pending = new Map<L, number>();
  for (const [line, n] of markers) {
    if (line.id) rows.set(line.id, n);
    else if (n > 0) pending.set(line, n);
  }
  await writeValues(db, rows);
  return pending;
}

type EditLine = {
  id?: string;
  qty: any;
  deliveredQty?: any;
  boxes?: unknown;
  pieces?: unknown;
  unitsPerBox?: unknown;
  unitLabel?: unknown;
};

/**
 * ADJUST on an edit (or SET for a re-decrement, `mode: "set"`), per product that moved. `deltas` is
 * `settleStockForEdit`'s booked per-product delta and `products` the locked rows read BEFORE the
 * counter writes (so `currentStock` is what the edit saw). Each line books `max(qty, delivered)`
 * (B1050), the same floor the counter uses. Lines are matched by id; a recreate-mode edit has no
 * matching ids and the caller skips this entirely (B1167: the marker is lost, documented).
 */
export async function applyEditMarkers(
  db: any,
  a: {
    mode: "adjust" | "set";
    allowOversell: boolean;
    products: Array<{ id: string; currentStock: unknown; unitsPerBox: unknown }>;
    deltas: ReadonlyMap<string, number>;
    heldLines: ReadonlyMap<string, EditLine[]>;
    finalLines: ReadonlyMap<string, EditLine[]>;
    /** the stock path's own qty-to-pieces conversion (never re-derived here) */
    piecesOf: (li: EditLine, qty: unknown, livePack: unknown) => number;
  },
): Promise<void> {
  const finalIds: string[] = [];
  for (const id of a.deltas.keys())
    for (const f of a.finalLines.get(id) ?? []) if (f.id) finalIds.push(f.id);
  if (finalIds.length === 0) return;
  const backorder = backorderPiecesForEditDelta({
    deltaByProduct: a.deltas,
    availableByProduct: new Map(a.products.map((p) => [p.id, Number(p.currentStock)])),
    allowOversell: a.allowOversell,
  });
  const rows: Array<{ id: string; position: number | null; backorderedPieces: unknown }> =
    await db.orderItem.findMany({
      where: { id: { in: finalIds } },
      select: { id: true, position: true, backorderedPieces: true },
    });
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, number>();
  for (const productId of a.deltas.keys()) {
    const pack = a.products.find((p) => p.id === productId)?.unitsPerBox;
    const heldById = new Map((a.heldLines.get(productId) ?? []).map((h) => [h.id, h]));
    const lines: EditMarkerLine[] = [];
    for (const f of a.finalLines.get(productId) ?? []) {
      const row = f.id ? rowById.get(f.id) : undefined;
      if (!f.id || !row) continue;
      const h = heldById.get(f.id);
      const delivered = h ? a.piecesOf(h, h.deliveredQty ?? 0, pack) : 0;
      lines.push({
        id: f.id,
        position: row.position,
        marker: Number(row.backorderedPieces),
        held: h ? Math.max(a.piecesOf(h, h.qty, pack), delivered) : 0,
        final: Math.max(a.piecesOf(f, f.qty, pack), delivered),
      });
    }
    for (const [id, n] of editMarkers({
      lines,
      backorder: backorder.get(productId) ?? 0,
      mode: a.mode,
    }))
      out.set(id, n);
  }
  await writeValues(db, out);
}
