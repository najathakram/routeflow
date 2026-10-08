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

/**
 * B1116: STAFF-ONLY field on the order detail read (`GET /orders/:id`) — never present on a buyer,
 * customer or driver read. `flagged` is the derived "this order's invoices no longer match its lines"
 * truth (the same predicate that makes Mark Delivered / Generate Invoice answer 409
 * ORDER_INVOICES_NEED_REVIEW); it is always the live state, so it clears itself once staff fix the
 * invoices. `flaggedAtStop` is decoration only (never changes `flagged`): present when a driver's stop
 * completion left the audit row that names who and when.
 */
export interface OrderInvoicesNeedReview {
  flagged: boolean;
  /** Why the office is being asked to look — present when `flagged`. */
  reason?: string;
  /** Who flagged it at a stop, and when (ISO), from the latest ORDER_INVOICES_NEED_REVIEW audit row. */
  flaggedAtStop?: { by: string; at: string };
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

// ─── Batch ship + packing slips (#3168) ────────────────────────────────────────────────────────
// "Mark shipped" for several carrier (fulfillPath SHIP) orders in one action, and one printable
// packing slip per order. The api keeps a literal copy of BATCH_SHIP_OUTCOMES (it cannot value-import
// this raw-TS package, L-072); apps/api/src/orders/order-batch-ship.spec.ts pins the two equal.

/** The per-order result of a batch ship. Refusals (everything but SHIPPED*) write nothing. */
export const BATCH_SHIP_OUTCOMES = [
  "SHIPPED",
  "SHIPPED_INVOICE_PENDING",
  "NOT_CARRIER_ORDER",
  "ALREADY_SHIPPED",
  "NOT_CONFIRMED",
  "CREDIT_HOLD",
  "ORDER_CHANGED",
  "INVALID_TRACKING",
  "NOT_FOUND",
  "FAILED",
] as const;
export type BatchShipOutcome = (typeof BATCH_SHIP_OUTCOMES)[number];

/** Most orders one batch ship / packing-slip request may carry. */
export const BATCH_SHIP_MAX_ORDERS = 50;

export interface BatchShipOrderInput {
  orderId: string;
  carrier?: string;
  trackingNumber?: string;
}

export interface BatchShipRequest {
  orders: BatchShipOrderInput[];
}

export interface BatchShipResultRow {
  orderId: string;
  orderNumber: string | null;
  outcome: BatchShipOutcome;
  message: string;
  /** True when the tracking was written but the order did not ship (the tracking stays saved). */
  trackingSaved?: boolean;
}

export interface BatchShipResult {
  results: BatchShipResultRow[];
}

export interface PackingSlipsRequest {
  orderIds: string[];
}

export interface PackingSlipsResult {
  /** Signed URL of ONE pdf with a page per included order. Null when nothing could be included. */
  url: string | null;
  included: string[];
  skipped: { orderId: string; outcome: BatchShipOutcome }[];
}

/**
 * B1201/B1205: the fixed sentence shown (web toast, mobile toast/alert) when an order was SAVED but
 * its credit notes were not applied. The server's own text is never shown. Shared by web and mobile.
 */
export const CREDITS_PENDING_COPY =
  "The order was saved, but the credit notes weren't applied. Apply them on the order.";
