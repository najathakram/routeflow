// ─── Orders (wave E / imp-10b) ──────────────────────────────────────────────
//
// Names identical or near-identical between apps/web/lib/api/orders.ts and
// apps/mobile/lib/api/orders.ts, per the DTO-duplication sweep. Near-identical
// resolution: field order/comments only — comment kept from the richer side.

export interface ActiveOrderSummary {
  id: string;
  orderNumber: string | null;
  status: "DRAFT" | "PENDING";
  itemCount: number;
  total: number;
  createdAt: string;
}

export interface CancelImpact {
  orderId: string;
  orderNumber: string;
  alreadyCancelled: boolean;
  invoicesToVoid: Array<{ id: string; invoiceNumber: string; status: string; total: number }>;
  creditsToRestore: Array<{ creditNoteId: string; creditNoteNumber: string; amount: number }>;
  advanceToRestore: number;
  blockingPayments: Array<{ invoiceNumber: string; amount: number }>;
  /** B56: units already delivered on this order — > 0 refuses the cancel. */
  deliveredUnits: number;
  canCancel: boolean;
}

export interface CustomerPriceHistory {
  [productId: string]: {
    lastPrice: number;
    listPriceAtTime: number;
  };
}

// ─── Multi-level units (2026-09-19) ─────────────────────────────────────────────
// See local-assets/handoff/2026-09-18/PLAN-units-po-MINIMAL.md §1-2.

/** The pack's own label when a line carries no explicit `unitLabel` (today's line). */
export const UNIT_LABEL_PIECE = "Piece" as const;

export interface UnitAwareLineInput {
  unitLabel?: string | null;
}
