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

/**
 * SA-606k/n: a buyer order line's backorder, in PIECES. The pieces of THIS line that the write took
 * below zero stock (the tenant must still source them); 0 means fully in stock. Present on every
 * line of a buyer create / merge / edit response; ABSENT means "not computed here" (a staff or
 * standing-order response) and must be read as UNKNOWN, never as 0. Pieces only: a client shows it in
 * the line's own unit by converting with the LINE's snapshot (a boxed line's `unitsPerBox`, a
 * unit-aware line's `factorToBase`), never the product's current pack.
 */
export interface BackorderLineFields {
  backorderPieces?: number;
}

// ─── Draft/park line price provenance (B755) ────────────────────────────────────
// Draft-only — never sent on the actual order-create/update payload. Distinct name
// from `ReturnPriceSource` (inline-returns.ts) on purpose: a different feature's
// "where did this price come from," and reusing the name would blur the two.

/**
 * Where a parked draft line's `unitPrice` came from: a remembered price-history
 * pre-fill, or an operator-typed override. A MISSING value on a legacy draft means
 * "operator" (today's behaviour, unchanged) — only an explicit "history" tag is
 * ever treated as non-authoritative on resume.
 */
export type DraftLinePriceSource = "history" | "operator";

/**
 * #2717 M3 (SA-572 A1, SA-589): one frozen component of a FIXED (mixed-pack) order or invoice line,
 * as clients read it. `qty` is whole pieces of that component on THIS line. `displayUnitPrice4` is
 * the stored 4-dp unit price (display only, never summed, taxed or credited: I5) or null; clients
 * print it through the shared `componentSubLineText` from `@routeflow/pricing`. A plain line has no
 * components (the array is absent or empty).
 */
export interface LineComponentView {
  id?: string;
  componentProductId: string;
  name: string;
  qty: number;
  unitSku: string | null;
  unitBarcode: string | null;
  barcodeSymbology: string | null;
  displayUnitPrice4: number | null;
  position: number;
}
