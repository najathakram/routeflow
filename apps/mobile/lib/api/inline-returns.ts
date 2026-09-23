// ─── Returns Inside Order Creation — INLINE capture, mobile mirror (PR 3) ───────
//
// Mirrors apps/web/lib/api/inline-returns.ts's hook shapes exactly — same endpoints, same
// response types (shared via @routeflow/types, never redeclared). The one platform
// difference: `returnKey` here comes from the caller already derived via
// `lib/inline-return-submit-key.ts` + `store/inlineReturnSubmissionStore.ts` (offline-queue
// safe — a plain useRef, web's approach, would mint a new UUID on an app-kill relaunch and
// mint a duplicate credit note). It travels as a normal BODY field (unlike the standard
// return flow's header-based Idempotency-Key) — apiClient's offline queue replays the POST
// body verbatim on reconnect, so keeping returnKey stable in the body is exactly what makes a
// queued replay collapse onto the original capture instead of minting a second one.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { inlineReturnNonceKey, shouldSettleInlineReturnNonce } from "../inline-return-submit-key";
import { useInlineReturnSubmissionStore } from "../../store/inlineReturnSubmissionStore";
import type {
  CaptureInlineReturnRequest,
  InlineReturnQuoteResponse,
  InlineReturnRecord,
  QuoteInlineReturnRequest,
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
} from "@routeflow/types";

/**
 * POST /returns/inline/quote — read-only, customer-scoped (no orderId). Never writes a
 * Return row. Render its `chunks`/totals exactly as returned — no client-side money math.
 */
export function useInlineReturnQuote() {
  return useMutation<InlineReturnQuoteResponse, Error, QuoteInlineReturnRequest>({
    mutationFn: (dto) => apiClient.post("/returns/inline/quote", dto).then((r) => r.data),
  });
}

/**
 * POST /returns/inline/capture. `returnKey` is REQUIRED on the DTO and MUST be derived by the
 * caller via `inlineReturnSubmitKey` + `useInlineReturnSubmissionStore` — never minted inline
 * here, and never a fresh value per call (see this file's header comment).
 */
export function useCaptureInlineReturn() {
  const qc = useQueryClient();
  const markCaptureSettled = useInlineReturnSubmissionStore((s) => s.markCaptureSettled);
  return useMutation<InlineReturnRecord, Error, CaptureInlineReturnRequest>({
    mutationFn: (dto) => apiClient.post("/returns/inline/capture", dto).then((r) => r.data),
    onSuccess: (data, variables) => {
      qc.invalidateQueries({ queryKey: ["orders", data.orderId] });
      qc.invalidateQueries({ queryKey: ["orders"] });
      qc.invalidateQueries({ queryKey: ["customers", data.customerId] });
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["returns"] });
      // SA-091 (B742 sibling): settle so the NEXT genuine capture on this pair mints a fresh
      // nonce, rather than colliding with this one's returnKey and silently replaying this
      // record.
      if (shouldSettleInlineReturnNonce({ kind: "success" })) {
        markCaptureSettled(inlineReturnNonceKey(variables.customerId, variables.orderId));
      }
    },
    onError: (error, variables) => {
      // `err.response` present means the server actually answered (a refusal) — terminal,
      // settle exactly like a success. Absent means the request never reached the server (a
      // connectivity failure, or the app was killed first) — the offline queue is expected to
      // replay this exact request, and the replay must reuse the SAME nonce or it becomes a
      // second, duplicate capture. Disclosed residual: if the app is killed AFTER the server
      // captured the return but BEFORE this handler runs, no handler runs at all and the nonce
      // persists until the next settle — a later replay of the identical request still resolves
      // correctly (the server's own returnKey uniqueness returns the same record), it is simply
      // not cleared promptly. Same accepted policy as the sibling standard-return flow.
      const reachedServer = (error as { response?: unknown })?.response != null;
      if (shouldSettleInlineReturnNonce({ kind: "error", reachedServer })) {
        markCaptureSettled(inlineReturnNonceKey(variables.customerId, variables.orderId));
      }
    },
  });
}
