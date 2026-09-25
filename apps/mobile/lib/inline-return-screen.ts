// Pure decision logic for the operator inline-return screen (quote -> confirm -> result),
// mirroring apps/web RecordInlineReturnDialog's step machine. Kept dependency-free so it is
// Jest-testable; the screen only wires hooks + UI to it. Money is never computed here — the
// quote's chunks/totals render as returned (@routeflow/returns groupQuoteChunks/sumChunkTotals).
import {
  buildQuoteRequest,
  hasAnyQtyEntered,
  type InlineReturnLineDraft,
} from "@routeflow/returns";
import type { InlineReturnQuoteResponse, InlineReturnRecord, ReturnReason } from "@routeflow/types";
import { inlineReturnSubmitKey } from "./inline-return-submit-key";

export type InlineReturnScreenState =
  | { step: "lines" }
  | { step: "quote"; quote: InlineReturnQuoteResponse }
  | { step: "success"; result: InlineReturnRecord }
  | { step: "refused"; message: string };

export type InlineReturnScreenEvent =
  | { type: "quoted"; quote: InlineReturnQuoteResponse }
  | { type: "captured"; result: InlineReturnRecord }
  | { type: "refused"; message: string }
  | { type: "edit" };

export const initialInlineReturnScreen: InlineReturnScreenState = { step: "lines" };

export function inlineReturnScreenReducer(
  state: InlineReturnScreenState,
  event: InlineReturnScreenEvent,
): InlineReturnScreenState {
  switch (event.type) {
    case "quoted":
      return { step: "quote", quote: event.quote };
    case "captured":
      // Capture is only reachable from a taken quote.
      return state.step === "quote" ? { step: "success", result: event.result } : state;
    case "refused":
      return { step: "refused", message: event.message };
    case "edit":
      return initialInlineReturnScreen;
  }
}

/** "Get quote" enables with a carrying order and any boxes/pieces entered. */
export function canGetInlineReturnQuote(lines: InlineReturnLineDraft[], orderId: string): boolean {
  return !!orderId && hasAnyQtyEntered(lines);
}

export function canConfirmInlineReturn(reason: ReturnReason | ""): boolean {
  return reason !== "";
}

/** The wire `returnKey` for this attempt: the persisted per-(customer,order) nonce (from
 *  useInlineReturnSubmissionStore.getOrCreateNonce). Deliberately independent of the lines, so
 *  a retry after an edit or re-quote resends the SAME key (one Return per attempt). */
export function screenReturnKey(customerId: string, orderId: string, nonce: string): string {
  return inlineReturnSubmitKey({ customerId, orderId }, nonce);
}

/** Mirrors web RecordReturnAction: fail CLOSED without the `orders_inline_returns` add-on
 *  (UX gate only — every /returns/inline/* route independently 403s server-side). */
export function inlineReturnsGate(addon: {
  enabled: boolean;
  resolved: boolean;
}): "loading" | "allowed" | "blocked" {
  if (!addon.resolved) return "loading";
  return addon.enabled ? "allowed" : "blocked";
}
