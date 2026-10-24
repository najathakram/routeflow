// ─── Returns Inside Order Creation — INLINE capture, office web (PR 1) ──────────
//
// Mirrors apps/web/lib/api/returns.ts's hook shapes (useCreateReturn etc.) — the STANDARD
// post-delivery RMA flow. This is the separate INLINE (order-entry-time) flow: quote →
// capture, no orderId on the quote (customer-scoped), returnKey required on capture. See
// .claude/code-map/api/returns-inline.md and local-assets/handoff/2026-09-22/
// SPEC-inline-returns-capture-web-PR1.md for the full contract.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  CaptureInlineReturnRequest,
  InlineReturnQuoteResponse,
  InlineReturnRecord,
  QuoteInlineReturnRequest,
  RefundInlineReturnRequest,
} from "@routeflow/types";

export type {
  CaptureInlineReturnItem,
  CaptureInlineReturnRequest,
  InlineReturnQuoteBreakdown,
  InlineReturnQuoteChunk,
  InlineReturnQuoteResponse,
  InlineReturnRecord,
  InlineReturnRecordItem,
  InlineReturnStatus,
  QuoteInlineReturnItem,
  QuoteInlineReturnRequest,
  RefundInlineReturnRequest,
  InlineRefundTender,
  InlineReturnResolution,
} from "@routeflow/types";

// ─── Mutations ────────────────────────────────────────────────────────────────
//
// Both are mutations, not queries: the quote is a read with side-effect-free semantics on
// the server, but it is deliberately requested on demand ("Get quote" button), never
// auto-fetched on keystroke — the brief's Step 1 gate is "Get quote enables when any qty >
// 0", not a debounced live quote.

/**
 * POST /returns/inline/quote — read-only, customer-scoped (no orderId). Never writes a
 * Return row. Render its `chunks`/totals exactly as returned — no client-side money math
 * (SA-071b item 5's sibling rule for the quote side: the server is the only place that
 * prices anything).
 */
export function useInlineReturnQuote() {
  return useMutation<InlineReturnQuoteResponse, Error, QuoteInlineReturnRequest>({
    mutationFn: (dto) => apiClient.post("/returns/inline/quote", dto).then((r) => r.data),
  });
}

/**
 * POST /returns/inline/capture. `returnKey` is REQUIRED on the DTO — the caller (the
 * capture dialog's pure state) mints one UUID per capture ATTEMPT and must keep it stable
 * across a retry of the SAME attempt; this hook does not mint or cache one itself.
 *
 * The response carries no `replayed` flag (SA-071a #2, corrected 2026-09-22: the service
 * never attaches one — `capture()` always returns a plain Return row). A retried submission
 * with the same `returnKey` therefore renders success identically to a fresh capture; there
 * is nothing to branch on here.
 */
export function useCaptureInlineReturn() {
  const qc = useQueryClient();
  return useMutation<InlineReturnRecord, Error, CaptureInlineReturnRequest>({
    mutationFn: (dto) => apiClient.post("/returns/inline/capture", dto).then((r) => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["orders", data.orderId] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["customers", data.customerId] });
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["returns"] });
    },
  });
}

/**
 * POS-4b: POST /returns/inline/:id/refund — pay a REFUND-resolution capture back (the standard
 * POST /returns/:id/refund refuses an inline return). Plain call (not a hook) so
 * the dialog can re-POST ONLY the refund on a retry; the capture's own cache invalidation already ran.
 * Errors: 409 REFUND_AMOUNT_CHANGED, RETURN_ALREADY_RESOLVED, REFUND_NEEDS_PAID_INVOICE,
 * RETURN_REFUNDED_CASH, RETURN_NOT_REFUNDABLE; 403. A network loss = retry the same POST (replay-safe).
 */
export function refundReturn(id: string, body: RefundInlineReturnRequest): Promise<unknown> {
  return apiClient.post(`/returns/inline/${id}/refund`, body).then((r) => r.data);
}

/**
 * SA-727b: POST /returns/inline/:id/store-credit — a saved REFUND-intent return whose refund is still
 * pending is credited instead (mints the credit note). Replay-safe; 409 RETURN_ALREADY_RESOLVED when
 * the return was already refunded or credited.
 */
export function storeCreditInstead(id: string): Promise<InlineReturnRecord> {
  return apiClient.post(`/returns/inline/${id}/store-credit`, {}).then((r) => r.data);
}
