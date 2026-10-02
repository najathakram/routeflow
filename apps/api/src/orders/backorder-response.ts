import { stockWriteOf, toPieces, type StockWriteResult } from "./order-stock";
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

/**
 * Which order a buyer create returns, and carries the figure on (SA-631d, Opus r1 + r2 on #3017):
 * the POST-SWEEP state of the order that holds THIS request's lines, read fresh with the shared
 * response include (the sweep's own return selects no pack, so it cannot be attributed). The holder
 * is decided by row EXISTENCE, never by the `skipAutoMerge` flag or the shape of the sweep's return:
 * only the sweep deletes an order between the commit and this response.
 *  1. `created` still exists -> it holds the lines, untouched or as the fold winner (the older orders'
 *     lines folded INTO it): return that fresh read with the figure;
 *  2. it is gone and the sweep returned another order -> `created` was folded into it: re-read that
 *     survivor and return it with the figure;
 *  3. neither can be read -> the holder is unknown: `merged ?? created` untouched, key omitted.
 * A concurrent edit between the sweep and the re-read is covered by `withBackorderPieces`' lost-write
 * rule (it omits the key). The write has COMMITTED, so this is TOTAL: a reader that throws is "gone".
 */
export async function buyerCreateResponse<C, M>(
  created: C,
  merged: M | null | undefined,
  readOrder: (id: string) => Promise<unknown>,
): Promise<unknown> {
  const read = async (id: unknown): Promise<unknown> => {
    if (typeof id !== "string") return null;
    try {
      return (await readOrder(id)) ?? null;
    } catch {
      return null; // a 404, a dropped connection: that holder is unknown
    }
  };
  try {
    const write = stockWriteOf(created);
    const createdId = (created as { id?: unknown } | null)?.id;
    const own = await read(createdId);
    if (own) return withBackorderPieces(own, write);
    const mergedId = (merged as { id?: unknown } | null | undefined)?.id;
    if (mergedId && mergedId !== createdId) {
      const survivor = await read(mergedId);
      if (survivor) return withBackorderPieces(survivor, write);
    }
  } catch {
    /* unknown holder: fall through */
  }
  return merged ?? created;
}
