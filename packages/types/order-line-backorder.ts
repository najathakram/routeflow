/**
 * SA-714 R1 / SA-716: the staff-only "Backorder" tag on an order line. `backorderedPieces` is the
 * PIECES of the line sold past available stock, written once by the locked stock section. It is a
 * DISPLAY fact only (never a status, never read by money/stock code), and it is never sent to buyers
 * (not in the customer order allowlist). The tag shows only while the order is still live: a
 * cancelled, delivered or draft order, or a cancelled line, shows none.
 */
const LIVE_ORDER_STATUSES: ReadonlySet<string> = new Set([
  "PENDING",
  "CONFIRMED",
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
]);

export const BACKORDER_TAG_LABEL = "Backorder";

/** Pieces to show on the tag, or 0 when the line carries none (the caller renders nothing for 0). */
export function lineBackorderPieces(
  line: { backorderedPieces?: unknown; status?: string | null },
  orderStatus: string,
): number {
  if (!LIVE_ORDER_STATUSES.has(orderStatus) || line.status === "CANCELLED") return 0;
  const n = Number(line.backorderedPieces);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
