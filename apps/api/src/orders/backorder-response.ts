import { toPieces, type StockWriteResult } from "./order-stock";
import { attributeBackorderToLines } from "./oversell-policy";

/**
 * SA-606o: the response attribution's piece reader and the buyer response figure.
 *
 * The stock write has COMMITTED by the time a response is built, so this is TOTAL: a throw here
 * would report a failure for a successful order and the buyer would retry it into a duplicate. Any
 * doubt OMITS `backorderPieces` on the WHOLE order (absent = unknown), never a guessed 0, NaN or a
 * partial figure. It writes nothing.
 *
 * The figure is the pieces THIS write backordered (per-write, response-only), attributed per product
 * over the response order's lines in response order, stock-first. A line's pieces are the
 * decrement's OWN conversion (`toPieces`, the line snapshot first, the product's pack as the
 * fallback) so demand cannot drift from what the write counted.
 */
type ResponseLine = {
  productId?: string | null;
  status?: string;
  qty?: unknown;
  product?: { unitsPerBox?: unknown } | null;
  boxes?: unknown;
  pieces?: unknown;
  unitsPerBox?: unknown;
  unitLabel?: unknown;
};

export function withBackorderPieces<T>(order: T, stockWrite: StockWriteResult | undefined): T {
  try {
    return build(order, stockWrite) ?? order;
  } catch {
    return order;
  }
}

function build<T>(order: T, stockWrite: StockWriteResult | undefined): T | undefined {
  const lines = (order as { lineItems?: unknown } | null)?.lineItems;
  if (!stockWrite || !Array.isArray(lines)) return undefined;
  const overshoot = stockWrite.backorderByProduct;

  const rows = (lines as ResponseLine[]).map((l) => {
    const counted = !!l.productId && l.status !== "CANCELLED";
    const livePack = l.product?.unitsPerBox;
    // No product row, or a read that did not select the pack: the decrement's fallback is unknowable
    // here (a box-unaware line's qty is BOXES), so the line is unresolvable rather than guessed.
    const packBad =
      !l.product ||
      !("unitsPerBox" in l.product) ||
      (livePack != null && !Number.isFinite(Number(livePack)));
    const pieces = counted && !packBad ? toPieces(l, l.qty, livePack) : counted ? Number.NaN : 0;
    return { productId: counted ? (l.productId as string) : null, pieces };
  });

  const demand = new Map<string, number>();
  for (const [productId, over] of overshoot) {
    if (!Number.isFinite(over) || over < 0) return undefined;
    const mine = rows.filter((r) => r.productId === productId);
    // A product the write touched whose lines we cannot size: unresolvable -> omit.
    if (mine.some((r) => !Number.isFinite(r.pieces) || r.pieces < 0)) return undefined;
    demand.set(
      productId,
      mine.reduce((sum, r) => sum + r.pieces, 0),
    );
    // Lost write (no line left) or a concurrent edit lowered the lines below the overshoot.
    if (over > 0 && (mine.length === 0 || demand.get(productId)! + 1e-9 < over)) return undefined;
  }

  const figures = attributeBackorderToLines(
    rows.map((r) => ({
      productId: r.productId,
      pieces: Number.isFinite(r.pieces) && r.pieces >= 0 ? r.pieces : 0,
    })),
    overshoot,
  );
  if (!figures.every((f) => Number.isFinite(f) && f >= 0)) return undefined;
  return {
    ...(order as object),
    lineItems: (lines as object[]).map((l, i) => ({ ...l, backorderPieces: figures[i] })),
  } as T;
}
