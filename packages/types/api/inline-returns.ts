// ─── Returns Inside Order Creation — INLINE capture (PR 1: office web) ──────────
//
// Mirrors apps/api/src/returns/dto/{quote,capture,approve}-inline-return.dto.ts field-for-
// field. There is NO response DTO on the api side (design.md / SA-071b item 4) — the quote
// response type below is derived from `InlineReturnsQuoteService.quote()`'s real return
// (apps/api/src/returns/inline-returns-quote.service.ts + inline-returns-pricing.ts's
// `QuoteBreakdown`/`PricedChunk`) and pinned to it by
// apps/api/src/returns/inline-returns-quote-response-parity.spec.ts. `priceSource` re-exports
// `./enums`'s `ReturnPriceSource` (itself already a mirror of
// apps/api/src/returns/inline-returns-pricing.ts's own `ReturnPriceSource` union) — never a
// second hand-typed copy (L-072: a hand-typed mirror of a server shape is how three real bugs
// shipped).

import type { ReturnReason } from "./enums";

export type { ReturnPriceSource } from "./enums";
import type { ReturnPriceSource } from "./enums";

// ─── Request: POST /returns/inline/quote ────────────────────────────────────────
//
// Customer-scoped, not order-scoped — no orderId. SA-128/B814: `boxes`/`pieces` are
// REQUIRED and at least one must be > 0 — bare `qty` is retired on this endpoint (a
// product's pack size can be unresolvable, and a bare qty in that state can't be told
// apart from a genuinely-unpacked product's qty, so guessing is unsafe either way). See
// quote-inline-return.dto.ts's own doc comment (QuoteInlineReturnItemDto).

export interface QuoteInlineReturnItem {
  productId: string;
  /** Still accepted (existing callers send `qty: 1`) but IGNORED — see the file-header
   *  note and `QuoteInlineReturnItemDto.qty`. */
  qty?: number;
  boxes: number;
  pieces: number;
}

export interface QuoteInlineReturnRequest {
  customerId: string;
  items: QuoteInlineReturnItem[];
  /** Required for a DRIVER caller only (M8) — an office (OPERATOR/TENANT_ADMIN) caller
   *  never sends this. */
  routeRunStopId?: string;
}

// ─── Request: POST /returns/inline/capture ───────────────────────────────────────

export interface CaptureInlineReturnItem {
  productId: string;
  /** Still accepted (existing callers send `qty: 1`) but IGNORED — see
   *  `QuoteInlineReturnItem.qty`. */
  qty?: number;
  boxes: number;
  pieces: number;
  /** Falls back to the capture's own top-level `reason` when omitted. Must be one of
   *  `RETURN_REASON_VALUES` (./enums) — never free text as the code. */
  reason?: ReturnReason;
  condition?: string;
  /** Defaults to the reason-driven server convention when omitted. */
  restock?: boolean;
}

export interface CaptureInlineReturnRequest {
  customerId: string;
  /** The order that CARRIES the credit — never necessarily the order(s) the goods were
   *  originally sold on (resolved server-side per item via ReturnItem.sourceOrderId). */
  orderId: string;
  items: CaptureInlineReturnItem[];
  /** Required for a DRIVER caller only (M8) — never sent by an office capture. */
  routeRunStopId?: string;
  /**
   * REQUIRED. One UUID minted per capture ATTEMPT (not per network call) — re-send the
   * SAME value unchanged on a retry. `@@unique([tenantId, returnKey])` server-side makes a
   * retried submission resolve to the same row instead of a duplicate. The capture response
   * carries no `replayed` flag (the service never attaches one to the Return row it
   * returns) — a successful replay is a plain 200 with the same Return object a fresh
   * capture would return, not a distinguishable shape.
   */
  returnKey: string;
  /** Capture-level fallback reason — required by the UI (per-item reason is optional). */
  reason?: ReturnReason;
  notes?: string;
  photoUrls?: string[];
}

// ─── Request: POST /returns/inline/:id/approve (PR 2 — typed here for completeness) ────

export interface ApproveInlineReturnRequest {
  /** >= 0.01 when present; omitted approves the full held amount. */
  amount?: number;
}

// ─── Response: what POST /returns/inline/quote actually returns ────────────────────
//
// No DTO exists on the api side for this — typed straight from
// `InlineReturnsQuoteService.quote()`'s real return type, pinned by
// inline-returns-quote-response-parity.spec.ts so this drifts loudly, never silently,
// if the pricing engine's shape ever changes.

export interface InlineReturnQuoteChunk {
  /** null = this chunk matched no invoice line at all — the "Not on any invoice"
   *  (excess/over-return) chunk, priced at the customer's current price. */
  sourceOrderId: string | null;
  sourceInvoiceItemId: string | null;
  sourceOrderItemId: string | null;
  productId: string;
  /** Pieces this chunk covers. */
  pieces: number;
  subtotal: number;
  taxAmount: number;
  categoryTax: number;
  priceSource: ReturnPriceSource;
  /** Display-only per-piece rate implied by this chunk (null when pieces is 0). */
  unitPrice: number | null;
  originalPrice?: number | null;
  overrideReason?: string | null;
  overriddenBy?: string | null;
}

export interface InlineReturnQuoteBreakdown {
  chunks: InlineReturnQuoteChunk[];
  subtotal: number;
  taxAmount: number;
  categoryTax: number;
  total: number;
}

/** The exact shape `POST /returns/inline/quote` resolves to (`quote()`'s
 *  `Promise<QuoteBreakdown & { productBreakdown: Record<string, QuoteBreakdown> }>`). */
export interface InlineReturnQuoteResponse extends InlineReturnQuoteBreakdown {
  /** Per-productId sub-breakdown — same shape as the top-level totals, scoped to one
   *  requested item. */
  productBreakdown: Record<string, InlineReturnQuoteBreakdown>;
}

// ─── Response: what POST /returns/inline/capture (and approve/reject/cancel) return ────
//
// No response DTO on the api side either — these methods are typed `Promise<any>` and
// return the raw Prisma `Return` row (`include: { items: true }`). Typed here from the
// Prisma model (apps/api/prisma/schema/sales.prisma `Return`/`ReturnItem`) rather than a
// service return-type parity spec, since `any` has no shape to pin against.

export interface InlineReturnRecordItem {
  id: string;
  productId: string;
  qty: number;
  reason: string | null;
  restock: boolean;
  condition?: string | null;
  notes?: string | null;
  /** INLINE-only provenance — the order the goods were actually SOLD on (may differ from
   *  the carrying `InlineReturnRecord.orderId`); dangles if the source is later voided. */
  sourceOrderId?: string | null;
  sourceInvoiceItemId?: string | null;
  sourceOrderItemId?: string | null;
  unitPrice?: number | null;
  subtotal?: number | null;
  taxAmount?: number | null;
  categoryTax?: number | null;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  priceSource?: ReturnPriceSource | null;
  originalPrice?: number | null;
  overrideReason?: string | null;
  overriddenBy?: string | null;
}

export type InlineReturnStatus = "RECEIVED" | "REFUNDED" | "REJECTED" | "CANCELLED";

/** B735: unresolved `RegulatedLedgerParkedReversal` rows for this return, read fresh right
 *  before the response is built (`InlineReturnsService.withParkedReversals`) — never a value
 *  threaded from the reversal call itself, so it's correct on every exit including a replay. */
export interface InlineReturnParkedReversals {
  count: number;
  pieces: number;
}

export interface InlineReturnRecord {
  id: string;
  returnNumber: string | null;
  orderId: string;
  customerId: string;
  reason: ReturnReason;
  status: InlineReturnStatus;
  notes?: string | null;
  photoUrls: string[];
  creditNoteId?: string | null;
  refundMethod?: string | null;
  refundAmount?: number | null;
  refundedAt?: string | null;
  kind: "INLINE";
  returnKey?: string | null;
  /** "DRIVER_CAP" while a driver-captured return awaits approval above the driver cap —
   *  an OFFICE capture never sets this (PR 1 asserts it stays null/absent). */
  holdReason?: string | null;
  heldAmount?: number | null;
  /** B735: non-null iff this return has an unresolved regulated-ledger park (the B681 park
   *  guard could not safely reverse a legacy/unknown box-axis SALE row). `null` = checked and clean; ABSENT =
   *  not checked (the post-commit read failed, or no tenant context) — never assume clean. */
  parkedReversals?: InlineReturnParkedReversals | null;
  creditSubtotal?: number | null;
  creditTax?: number | null;
  creditCategoryTax?: number | null;
  items: InlineReturnRecordItem[];
  createdAt: string;
  updatedAt: string;
}
