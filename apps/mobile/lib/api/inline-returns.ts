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
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { DRIVER_CRITICAL_NETWORK_MODE } from "../live-online";
import { captureSettleHandlers } from "../inline-return-submit-key";
import { useOfflineQueue, type QueuedAction } from "../../store/offlineQueue";
import type { FailedActionRecord } from "../queue-drain";
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
    mutationFn: (dto) =>
      apiClient
        // Read-only: a quote must never be offline-queued (see api-client `_skipOfflineQueue`).
        .post("/returns/inline/quote", dto, { _skipOfflineQueue: true } as object)
        .then((r) => r.data),
  });
}

/**
 * POST /returns/inline/capture. `returnKey` is REQUIRED on the DTO and MUST be derived by the
 * caller via `inlineReturnSubmitKey` + `useInlineReturnSubmissionStore` — never minted inline
 * here, and never a fresh value per call (see this file's header comment).
 */
type CaptureVars = CaptureInlineReturnRequest;

/** Mutation options for the capture hook, factored out so the two settle calls are testable
 *  behaviourally (a deleted or mis-wired settle call turns the test red). */
export function buildCaptureMutationOptions(
  qc: Pick<QueryClient, "invalidateQueries">,
  settleCapture: Parameters<typeof captureSettleHandlers<CaptureVars>>[0],
  failed?: Parameters<typeof captureSettleHandlers<CaptureVars>>[1],
): UseMutationOptions<InlineReturnRecord, Error, CaptureVars> {
  const settle = captureSettleHandlers<CaptureVars>(settleCapture, failed);
  return {
    // #2420 (F2 at 27271e9c): never PAUSE offline — TanStack's default "online" mode held a capture
    // confirmed offline as a spinner (no "Saved offline", empty queue) until reconnect. Fail fast so
    // the api-client interceptor queues it and the screen shows the queued result (#2265 class).
    networkMode: DRIVER_CRITICAL_NETWORK_MODE,
    mutationFn: (dto) => apiClient.post("/returns/inline/capture", dto).then((r) => r.data),
    onSuccess: (data, variables) => {
      // Mobile's OWN query keys (lib/api/admin.ts, returns.ts, credit-notes.ts) — web's bare
      // ["orders"]/["customers"] keys are used by no mobile screen and left them stale.
      qc.invalidateQueries({ queryKey: ["admin", "orders", data.orderId] });
      qc.invalidateQueries({ queryKey: ["admin", "orders"] });
      qc.invalidateQueries({ queryKey: ["admin", "customers", data.customerId] });
      qc.invalidateQueries({ queryKey: ["admin", "returns"] });
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["returns"] });
      // SA-091 (B742 sibling): settle only THIS attempt's own nonce, so the NEXT genuine capture
      // on the pair mints fresh (see captureSettleHandlers / settleDirectCapture).
      settle.onSuccess(data, variables);
    },
    onError: (error, variables) => {
      // SA-091a/SA-091b precision: `captureOutcomeFromError` is the ONE place that classifies
      // this endpoint's errors (shared with the offline-queue drain's settleAfterDrain, via the
      // same isDefiniteInlineReturnRefusal core) — an `isOfflineQueued` error is a THIRD shape,
      // "not attempted yet", never settled here; the queue's own drain settles it later, for
      // real, once it actually lands or fails. A DEFINITE 4xx refusal is terminal, settle
      // exactly like a success. A 5xx, the stuck-row retry-409 (inline-returns.service.ts's
      // issueCreditInTx guard — retrying with the SAME returnKey is how that row's credit
      // actually gets issued, since the Return row and its credit commit in SEPARATE
      // transactions), and no response at all are all UNCERTAIN outcomes: settling would let a
      // retry mint a fresh key and double-book if the first attempt actually landed. Disclosed
      // residual, NOT the same policy as the sibling standard-return flow (that one clears on
      // "landed OR queued" and blocks re-submits via its own `submitted` flag —
      // returnSubmissionStore.ts's markSubmitted; this flow settles purely on outcome certainty
      // and never blocks a later attempt): if the app is killed AFTER the server captures the
      // return but BEFORE this handler runs, no handler runs at all and the nonce persists
      // until the next settle. A later replay of the identical request still resolves correctly
      // (the server's own returnKey uniqueness returns the same record), it is simply not
      // cleared promptly.
      settle.onError(error, variables);
    },
  };
}

export function useCaptureInlineReturn() {
  const qc = useQueryClient();
  const settleCapture = useInlineReturnSubmissionStore((s) => s.settleCapture);
  // SA-198: a direct capture that keeps its nonce is recorded in failedActions so sign-out /
  // sign-in can rebuild it; a settle removes the record.
  return useMutation<InlineReturnRecord, Error, CaptureVars>(
    buildCaptureMutationOptions(qc, settleCapture, {
      add: (record) => {
        const q = useOfflineQueue.getState();
        q.clearFailedAction(record.action.id);
        q.addFailedAction(record as unknown as FailedActionRecord & { action: QueuedAction });
      },
    }),
  );
}
