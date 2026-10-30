// ─── Returns / credit notes (wave E / imp-10b) ──────────────────────────────────

import type { ReturnReason } from "./enums";

/** Superset of both apps' optional fields: web has `notes`, mobile has `reason`
 *  (both apps already carry `restock`). */
export interface CreateReturnItemDto {
  productId: string;
  qty: number;
  notes?: string;
  /** Optional per-item reason (defaults to the return's top-level reason server-side). */
  reason?: ReturnReason;
  /** Whether to add the returned qty back to stock on receive (defaults from the reason). */
  restock?: boolean;
  /** Free-form condition note captured at intake (e.g. "DAMAGED_BOX"). */
  condition?: string;
  /**
   * SA-1042 B9b: the ORDER LINE this item returns. With it the item is a LINE item: it is capped on that line and credited
   * at that line's own price. Without it the item is POOLED (every line of the product), exactly as before. The wire names a
   * line, never a unit (SA-158 (a)).
   */
  orderItemId?: string;
  /**
   * A line item counted in the line's OWN unit: `boxes` of it plus loose `pieces` (so "1 Case" is `boxes: 1`). Accepted only
   * on a line that stores a split or is a factor-1 unit; any other line takes `qty` in its own unit. Never with `qty`.
   */
  boxes?: number;
  pieces?: number;
}

/**
 * B959: a returned item that was NOT billed on the order, so it got no refund (a mixed return still refunds the billed part).
 * `processRefund` returns these as `unbilledItems`, each with a readable `message`, so a refund is never a silent $0.
 */
export interface UnbilledReturnItem {
  productId: string;
  name: string;
  qty: number;
  message: string;
}
