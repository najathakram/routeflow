// Pure decision logic for the operator inline-return screen (lines -> quote -> confirm ->
// result), mirroring apps/web RecordInlineReturnDialog's step machine. Kept dependency-free so it
// is Jest-testable; the screen only wires hooks + UI to it. Money is never computed here — the
// quote's chunks/totals render as returned (@routeflow/returns groupQuoteChunks/sumChunkTotals).
import {
  buildCaptureRequest,
  DEFAULT_EXCESS_OPTION,
  extractRefusalMessage,
  hasAnyQtyEntered,
  type ExcessOption,
  type InlineReturnLineDraft,
} from "@routeflow/returns";
import { formatQtySplit } from "@routeflow/pricing";
import type {
  CaptureInlineReturnRequest,
  InlineReturnQuoteResponse,
  InlineReturnRecord,
  ReturnReason,
} from "@routeflow/types";
import { captureOutcomeFromError, inlineReturnSubmitKey } from "./inline-return-submit-key";

export const ORDERS_INLINE_RETURNS_ADDON = "orders_inline_returns";

/**
 * The screen's step machine. `quotedLines` is the SNAPSHOT of the lines the quote was priced on
 * (SA-071b §8.1a(5)): capture reads it, never the live, still-editable lines, so the confirmed
 * credit can never diverge from the quote the operator saw.
 *
 *  - `capturing` is a pending capture: navigation is locked (`canLeaveInlineReturn`) because a
 *    capture that already landed must never be dropped — the next confirm would mint a fresh key
 *    and book a second Return and credit.
 *  - `queued` is a PENDING SUCCESS (REG-B308: the offline queue accepted the capture), never an
 *    error.
 */
export type InlineReturnScreenState =
  | { step: "lines" }
  | {
      step: "quote";
      quote: InlineReturnQuoteResponse;
      quotedLines: InlineReturnLineDraft[];
      excessOption: ExcessOption;
    }
  | {
      step: "capturing";
      quote: InlineReturnQuoteResponse;
      quotedLines: InlineReturnLineDraft[];
      excessOption: ExcessOption;
    }
  | { step: "success"; result: InlineReturnRecord }
  | { step: "queued" }
  | { step: "refused"; message: string };

export type InlineReturnScreenEvent =
  | {
      type: "quoted";
      quote: InlineReturnQuoteResponse;
      lines: InlineReturnLineDraft[];
      /** Omit on a fresh quote so the option resets to the default. */
      excessOption?: ExcessOption;
    }
  | { type: "captureStarted" }
  | { type: "captured"; result: InlineReturnRecord }
  | { type: "queued" }
  | { type: "refused"; message: string }
  | { type: "edit" };

export const initialInlineReturnScreen: InlineReturnScreenState = { step: "lines" };

export function inlineReturnScreenReducer(
  state: InlineReturnScreenState,
  event: InlineReturnScreenEvent,
): InlineReturnScreenState {
  // A landed / queued capture is final for this screen: nothing (a late refusal, a stray
  // re-quote) may overwrite it.
  const settled = state.step === "success" || state.step === "queued";
  switch (event.type) {
    case "quoted":
      if (state.step === "capturing" || settled) return state;
      return {
        step: "quote",
        quote: event.quote,
        // Snapshot — a copy, so later edits to the live array cannot reach it.
        quotedLines: event.lines.map((l) => ({ ...l })),
        excessOption: event.excessOption ?? DEFAULT_EXCESS_OPTION,
      };
    case "captureStarted":
      return state.step === "quote" ? { ...state, step: "capturing" } : state;
    case "captured":
      // ALWAYS show a landed result, whatever step the operator is on.
      return { step: "success", result: event.result };
    case "queued":
      return state.step === "success" ? state : { step: "queued" };
    case "refused":
      return settled ? state : { step: "refused", message: event.message };
    case "edit":
      return state.step === "capturing" ? state : initialInlineReturnScreen;
  }
}

/** Back / edit is locked while a capture is in flight. */
export function canLeaveInlineReturn(state: InlineReturnScreenState): boolean {
  return state.step !== "capturing";
}

/** A removal blocked mid-capture is either a USER back press (GO_BACK / POP: simply dropped — the
 *  result must stay visible) or a FORCED redirect (reset / replace / navigate, e.g. the
 *  session-expired handler): those are deferred and re-dispatched once the capture settles. */
export function isDeferrableRemoval(action: { type: string }): boolean {
  return action.type !== "GO_BACK" && action.type !== "POP";
}

/** Statuses answered BEFORE the capture handler runs (auth, permission, the validation pipe): a
 *  DEFINITE non-write — nothing was recorded — even though the nonce is kept for a later retry. */
const DEFINITE_NON_WRITE_STATUSES = new Set([400, 401, 403]);

/** The copy for a failed capture. A coded business refusal shows the server's own message; a
 *  definite non-write (401/403/code-less 400) says nothing was recorded; anything else is
 *  UNCERTAIN — the capture may have landed — so it must not read as a refusal: retrying resends
 *  the SAME request (same key), which the server collapses. */
export function captureFailureMessage(error: unknown): string {
  const outcome = captureOutcomeFromError(error);
  if (outcome.kind === "error" && outcome.refused) return extractRefusalMessage(error);
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 401) {
    return "Your session expired, so this attempt wasn't recorded. Sign in again and retry.";
  }
  if (status !== undefined && DEFINITE_NON_WRITE_STATUSES.has(status)) {
    // "this ATTEMPT": an earlier uncertain attempt with the same key may still have landed.
    const msg = extractRefusalMessage(error);
    return `${msg}${/[.!?]$/.test(msg) ? "" : "."} This attempt wasn't recorded.`;
  }
  return "We couldn't confirm this return went through. Trying again sends the same request, so it won't be recorded twice.";
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

/** The capture request, built ONLY from the state's quoted snapshot — the screen cannot pass
 *  live lines, so the two can never diverge. Null when there is no quote to capture. */
export function buildInlineReturnCapture(
  state: InlineReturnScreenState,
  params: { customerId: string; orderId: string; nonce: string; reason: ReturnReason },
): CaptureInlineReturnRequest | null {
  if (state.step !== "quote" && state.step !== "capturing") return null;
  return buildCaptureRequest({
    customerId: params.customerId,
    orderId: params.orderId,
    lines: state.quotedLines,
    returnKey: screenReturnKey(params.customerId, params.orderId, params.nonce),
    reason: params.reason,
  });
}

/** `refundAmount` is a Prisma Decimal serialised as a STRING — format it, never type-test it. */
export function formatRefundAmount(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : null;
}

/** A line draft pre-filled from the carrying order, plus display-only sold labels. */
export type PrefilledReturnLine = InlineReturnLineDraft & { soldLabel: string; boxLabel?: string };

interface OrderLineLike {
  productId: string | null;
  status?: string;
  name?: string | null;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
  product?: { name: string; unit: string; unitsPerBox?: number | null } | null;
}

/** Pre-fills the return lines from the carrying order. The pack size is the line's SOLD
 *  snapshot (`unitsPerBox`), falling back to the live product pack only when absent — a product
 *  whose pack changed since the sale must still be returned in the units it was sold in. */
export function linesFromOrder(lineItems: ReadonlyArray<OrderLineLike>): PrefilledReturnLine[] {
  const seen = new Set<string>();
  const out: PrefilledReturnLine[] = [];
  for (const li of lineItems) {
    // A cancelled line was never delivered — nothing to return against it.
    if (!li.productId || li.status === "CANCELLED" || seen.has(li.productId)) continue;
    seen.add(li.productId);
    const unitLabel = li.unitLabel?.trim() || undefined;
    out.push({
      productId: li.productId,
      productName: li.product?.name ?? li.name ?? "Item",
      unit: li.product?.unit ?? null,
      unitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
      qtySold: li.qty,
      boxes: "",
      pieces: "",
      reason: "",
      note: "",
      soldLabel: formatQtySplit({
        qty: li.qty,
        boxes: li.boxes,
        pieces: li.pieces,
        boxLabel: unitLabel,
      }),
      ...(unitLabel ? { boxLabel: unitLabel } : {}),
    });
  }
  return out;
}

/** Reads the add-ons payload: resolved is keyed off the DATA (a failed refetch keeps the last
 *  good data, so the gate never flickers back to "loading"). */
export function inlineReturnsAddonState(data: { addons?: string[] } | undefined): {
  enabled: boolean;
  resolved: boolean;
} {
  return {
    enabled: data?.addons?.includes(ORDERS_INLINE_RETURNS_ADDON) ?? false,
    resolved: data !== undefined,
  };
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
