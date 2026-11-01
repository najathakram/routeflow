"use client";

// ─── R-1 (SA-1069 M3/M4): the return's credit, worked out as the lines change ───────────────────
//
// One list, no "Get quote": after RETURN_QUOTE_DEBOUNCE_MS of quiet this asks `POST /returns/inline/quote` for the lines'
// request. One request runs at a time, the newest key wins, and a reply for an older key is dropped. The quote is CURRENT only
// while its key equals the lines' key: change a quantity and it is gone at once ("pending"), never a figure from lines that
// no longer exist. Read-only on the server, so no idempotency key. The client computes no money: the reply is shown as sent.
import * as React from "react";
import {
  buildQuoteRequest,
  creditOverrideProblem,
  extractRefusalMessage,
  type InlineReturnLineDraft,
} from "@routeflow/returns";
import type { InlineReturnQuoteResponse, QuoteInlineReturnRequest } from "@routeflow/types";
import { useInlineReturnQuote } from "@/lib/api/inline-returns";
import { QUOTE_FAILED_COPY, isQuoteFailure } from "./quote-failure";

export const RETURN_QUOTE_DEBOUNCE_MS = 350;

/** none: nothing to quote. pending: the lines changed and no answer for them yet. current: the quote is for these lines.
 *  refused: the server (or the lines themselves) said no, with a sentence. failed: no answer came back at all. */
export type LiveQuoteStatus = "none" | "pending" | "current" | "refused" | "failed";

export interface LiveReturnQuote {
  status: LiveQuoteStatus;
  /** Non-null only while `status` is "current". */
  quote: InlineReturnQuoteResponse | null;
  /** The last quote that came back, for a dimmed summary while the next one is pending. Display only, never a draft. */
  lastQuote: InlineReturnQuoteResponse | null;
  /** The sentence for "refused" or "failed". */
  message: string;
  /** "invalid": the lines' own credit price is incomplete (no request was sent). "server": the quote came back refused. */
  messageKind: "invalid" | "server" | null;
  /** The product a refusal names (RETURN_EXCEEDS_SALE and the override codes carry it). */
  refusedProductId: string | null;
  /** Failed only: ask again for the same lines. */
  retry: () => void;
}

type Settled =
  | { key: string; ok: true; quote: InlineReturnQuoteResponse }
  | {
      key: string;
      ok: false;
      kind: "refused" | "failed";
      message: string;
      productId: string | null;
    };

export function useLiveReturnQuote({
  lines,
  customerId,
  sourceOrderId,
  editingOrderId,
  enabled = true,
}: {
  lines: InlineReturnLineDraft[];
  customerId: string;
  sourceOrderId?: string;
  /** SA-1060 A-4: the order being edited, sent only by the order edit's Returns section. */
  editingOrderId?: string;
  /** False = the host is not ready (no carrying order yet) or the draft is locked: nothing is asked. */
  enabled?: boolean;
}): LiveReturnQuote {
  const mutation = useInlineReturnQuote();
  const request = React.useMemo(
    () => buildQuoteRequest(customerId, lines, undefined, sourceOrderId, editingOrderId),
    [customerId, lines, sourceOrderId, editingOrderId],
  );
  const key = React.useMemo(() => JSON.stringify(request), [request]);
  const invalid = React.useMemo(() => creditOverrideProblem(lines), [lines]);
  const sendable = request.items.length > 0 && invalid === null;

  const [settled, setSettledState] = React.useState<Settled | null>(null);
  const settledKey = React.useRef<string | null>(null);
  const setSettled = React.useCallback((value: Settled | null) => {
    settledKey.current = value ? value.key : null;
    setSettledState(value);
  }, []);
  const [lastQuote, setLastQuote] = React.useState<InlineReturnQuoteResponse | null>(null);

  const latestKey = React.useRef("");
  const latestRequest = React.useRef<QuoteInlineReturnRequest | null>(null);
  const inFlight = React.useRef(false);
  const wanted = React.useRef<{ key: string; request: QuoteInlineReturnRequest } | null>(null);
  const mounted = React.useRef(true);
  const mutateRef = React.useRef(mutation.mutate);
  mutateRef.current = mutation.mutate;
  latestKey.current = sendable ? key : "";
  latestRequest.current = sendable ? request : null;

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const send = React.useCallback(
    (sentKey: string, sentRequest: QuoteInlineReturnRequest) => {
      if (inFlight.current) {
        wanted.current = { key: sentKey, request: sentRequest }; // one at a time: it goes when the one in flight is back
        return;
      }
      inFlight.current = true;
      const finish = (result: Settled | null) => {
        inFlight.current = false;
        if (!mounted.current) return;
        if (result && result.key === latestKey.current) {
          setSettled(result);
          if (result.ok) setLastQuote(result.quote);
        } // else: a reply for older lines, dropped
        const next = wanted.current;
        wanted.current = null;
        if (next && next.key === latestKey.current) send(next.key, next.request);
      };
      mutateRef.current(sentRequest, {
        onSuccess: (data) => finish({ key: sentKey, ok: true, quote: data }),
        onError: (err) => {
          const productId = (err as { response?: { data?: { productId?: unknown } } } | undefined)
            ?.response?.data?.productId;
          finish(
            isQuoteFailure(err)
              ? {
                  key: sentKey,
                  ok: false,
                  kind: "failed",
                  message: QUOTE_FAILED_COPY,
                  productId: null,
                }
              : {
                  key: sentKey,
                  ok: false,
                  kind: "refused",
                  message: extractRefusalMessage(err),
                  productId: typeof productId === "string" ? productId : null,
                },
          );
        },
      });
    },
    [setSettled],
  );

  // the debounce: every change of the lines' key restarts it, and only a sendable, enabled key is ever asked
  // (keyed on the request's text, not its identity: a note typed on a line must not restart it or ask again)
  React.useEffect(() => {
    if (!sendable || !enabled || settledKey.current === key) return;
    const timer = window.setTimeout(() => {
      if (latestRequest.current) send(key, latestRequest.current);
    }, RETURN_QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [key, sendable, enabled, send]);

  const retry = React.useCallback(() => {
    const req = latestRequest.current;
    if (!req) return;
    setSettled(null);
    send(latestKey.current, req);
  }, [send, setSettled]);

  const base = { lastQuote, retry, refusedProductId: null as string | null };
  if (invalid !== null && request.items.length > 0) {
    return { ...base, status: "refused", quote: null, message: invalid, messageKind: "invalid" };
  }
  if (!sendable) {
    return { ...base, status: "none", quote: null, message: "", messageKind: null };
  }
  if (settled && settled.key === key) {
    if (settled.ok) {
      return { ...base, status: "current", quote: settled.quote, message: "", messageKind: null };
    }
    return {
      ...base,
      status: settled.kind,
      quote: null,
      message: settled.message,
      messageKind: "server",
      refusedProductId: settled.kind === "refused" ? settled.productId : null,
    };
  }
  if (!enabled) return { ...base, status: "none", quote: null, message: "", messageKind: null };
  return { ...base, status: "pending", quote: null, message: "", messageKind: null };
}
