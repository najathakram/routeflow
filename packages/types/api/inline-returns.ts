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
  /** #2695 (SA-557): OPERATOR/TENANT_ADMIN only — a lower-only per-SELLING-unit credit price
   *  (one box when boxed), capped at the engine's default (400 `RETURN_CREDIT_OVER_CAP` above it).
   *  Always sent WITH `overrideReason`, on the quote and the capture alike; a driver or buyer
   *  request carrying either field is a 400. */
  creditUnitPrice?: number;
  /** #2695: why — required with `creditUnitPrice`, trimmed, ≤ 200 characters. */
  overrideReason?: string;
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
  /** #2695: see `QuoteInlineReturnItem.creditUnitPrice` — the capture must send the SAME
   *  override its quote priced, or the two price different chunks. */
  creditUnitPrice?: number;
  overrideReason?: string;
  /** B961 / SA-071c: OPERATOR/TENANT_ADMIN only — why goods the customer already returned or was credited for are credited
   *  again; REQUIRED when the quote flagged the line's over-return chunk `alreadyReturned` (400 coded otherwise). */
  alreadyReturnedReason?: string;
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
  /** POS-4b: what the customer gets back. Omitted = STORE_CREDIT (today's behaviour). REFUND mints no credit note;
   *  the client then POSTs /returns/:id/refund. */
  resolution?: InlineReturnResolution;
}

export type InlineReturnResolution = "STORE_CREDIT" | "REFUND";
export type InlineReturnRefundTender = "CASH" | "CARD" | "CHECK";

/** POST /returns/inline/:id/refund body (POS-4b). 409 REFUND_AMOUNT_CHANGED / RETURN_ALREADY_RESOLVED /
 *  REFUND_NEEDS_PAID_INVOICE / RETURN_REFUNDED_CASH / RETURN_NOT_REFUNDABLE, 403. */
export interface RefundInlineReturnRequest {
  tender: InlineReturnRefundTender;
  expectedAmount: number;
  reason?: string;
}

// ─── Request: inlineReturn embedded on order create/edit (#2406) ───────────────
//
// The shape carried on `POST /orders`'s `inlineReturn` and `PATCH /orders/:id/items`'s
// `inlineReturn` — a `CaptureInlineReturnRequest` minus `customerId`/`orderId`, both DERIVED
// server-side from the order being created/edited (never sent by the client). Mirrors
// `InlineReturnLinesDto` (apps/api/src/returns/dto/capture-inline-return.dto.ts) field-for-
// field. Web's create/update order payload types (`useCreateOrder`/`useUpdateOrderItems` in
// apps/web/lib/api/orders.ts) reference this rather than redeclaring it.
export type InlineReturnLinesRequest = Omit<CaptureInlineReturnRequest, "customerId" | "orderId">;

// ─── Request: POST /returns/inline/:id/approve (PR 2 — typed here for completeness) ────

export interface ApproveInlineReturnRequest {
  /** >= 0.01 when present; omitted approves the full held amount. */
  amount?: number;
  /** B961: REQUIRED to approve a hold the capture marked "already returned or credited" (400
   *  `INLINE_RETURN_ALREADY_RETURNED_REASON_REQUIRED` otherwise); trimmed, <= 200 characters. */
  reason?: string;
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
  /** B961 / SA-071c: set on an over-return chunk of a product this customer DID buy (a candidate invoice line exists, all of it
   *  already returned or credited). Shown as "already returned or credited", NOT "not on any invoice"; only staff may credit it,
   *  with a reason; a driver capture holds it for the office. Absent on every other chunk. */
  alreadyReturned?: boolean;
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

/** POS-4b: refund eligibility the quote will carry once the API ships it. Kept OUT of
 *  `InlineReturnQuoteResponse` (pinned to the engine's real shape by the API parity spec) until then;
 *  web reads it as `InlineReturnQuoteResponse & Partial<InlineReturnRefundEligibility>`. */
export interface InlineReturnRefundEligibility {
  canRefund: boolean;
  paidInFull: boolean;
  paidMethods: InlineReturnRefundTender[];
  customerIsWalkIn: boolean;
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
  /** A Prisma Decimal: JSON carries it as a STRING ("22.5000"); consumers parse it (refundAmountOf). */
  refundAmount?: number | string | null;
  refundedAt?: string | null;
  kind: "INLINE";
  returnKey?: string | null;
  /** "DRIVER_CAP" while a driver-captured return awaits approval above the driver cap, or "ALREADY_RETURNED" (B961, wins over
   *  DRIVER_CAP) while it awaits staff approval WITH a reason because its chunk is goods already returned or credited —
   *  an OFFICE capture never sets this (PR 1 asserts it stays null/absent). */
  holdReason?: string | null;
  heldAmount?: number | null;
  /** B961: true on a capture/replay response whose return is HELD because its chunk is "already returned or credited"
   *  (not persisted: derived from `holdReason === "ALREADY_RETURNED"`), with the readable sentence for the driver. */
  alreadyReturnedHold?: boolean;
  holdMessage?: string;
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
