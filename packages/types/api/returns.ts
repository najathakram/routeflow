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
