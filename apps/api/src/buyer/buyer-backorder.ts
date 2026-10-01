import { attributeBackorderToLines, type BackorderLine } from "../orders/oversell-policy";
import type { StockOutcomeSink } from "../orders/order-stock";

/**
 * Buyer backorderPieces (SA-606k): stamp every line of a buyer order response with
 * `backorderPieces` - PIECES, never boxes (the UI converts with the line's own snapshot). The
 * per-product overshoot comes from the sink the locked stock write filled; lines of a product take
 * stock first in line order, so the overshoot lands on the later lines. An empty sink (policy off,
 * enough stock) stamps 0 everywhere. A response with no `lineItems` array passes through untouched.
 */
export function withBackorderPieces<T extends { lineItems?: unknown } | null | undefined>(
  order: T,
  sink: StockOutcomeSink,
): T {
  const lines = order?.lineItems;
  if (!Array.isArray(lines)) return order;
  const per = attributeBackorderToLines(
    lines as Array<BackorderLine & { productId: string | null }>,
    sink.backorderByProduct,
    sink.packByProduct,
  );
  return {
    ...(order as object),
    lineItems: lines.map((li, i) => ({ ...(li as object), backorderPieces: per[i] })),
  } as T;
}
