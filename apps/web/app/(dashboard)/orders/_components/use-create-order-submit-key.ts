import * as React from "react";
import { API_ERROR_CODES } from "@routeflow/types";

/**
 * BUG-A: one submit attempt of the Create Order modal = one `Idempotency-Key`, and at most one
 * request in flight. POST /orders already replays on that key (F30/R8, B215); the modal simply
 * never sent one on a plain create, and `createOrder.isPending` is stale for the second click of
 * a double click (react-hook-form's handleSubmit is async, so both clicks reach `mutate` before the
 * first render that would disable the button).
 *
 * Key lifecycle (lead ruling): minted when the modal opens; re-minted ONLY after a KNOWN outcome
 * (2xx, or a definitive 4xx refusal that wrote nothing) or when the cart changed with nothing in
 * flight and no unknown outcome; KEPT after an UNKNOWN outcome (no response / timeout / 5xx) even
 * if the cart is then edited — the server's replay / request hash answers. A precondition 4xx the
 * modal resolves and re-submits itself (merge prompt, license capture) is the SAME attempt: keep.
 */
export type SubmitOutcome = "success" | "refused" | "unknown" | "same-attempt";

export function mintSubmitKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** No response at all, a timeout or a 5xx: the server may or may not have written the order. */
export function isUnknownOutcome(err: unknown): boolean {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status == null || status === 408 || status >= 500;
}

interface State {
  key: string;
  fingerprint: string | null;
  inFlight: boolean;
  unknown: boolean;
}

export function useCreateOrderSubmitKey(isOpen: boolean) {
  const st = React.useRef<State | null>(null);
  if (st.current === null) {
    st.current = { key: mintSubmitKey(), fingerprint: null, inFlight: false, unknown: false };
  }
  // Mint on OPEN: every open of the modal is a fresh cart session.
  React.useEffect(() => {
    if (isOpen) {
      st.current = { key: mintSubmitKey(), fingerprint: null, inFlight: false, unknown: false };
    }
  }, [isOpen]);

  return React.useMemo(
    () => ({
      /** The key for this attempt, or null when one is already in flight (the caller must not send). */
      begin(fingerprint: string): string | null {
        const s = st.current!;
        if (s.inFlight) return null;
        if (!s.unknown && s.fingerprint !== null && s.fingerprint !== fingerprint) {
          s.key = mintSubmitKey(); // a plain cart edit with nothing in flight
        }
        s.fingerprint = fingerprint;
        s.inFlight = true;
        return s.key;
      },
      /** Release the latch and apply the outcome to the key. */
      settle(outcome: SubmitOutcome): void {
        const s = st.current!;
        s.inFlight = false;
        if (outcome === "unknown") {
          s.unknown = true;
        } else if (outcome === "success" || outcome === "refused") {
          s.key = mintSubmitKey();
          s.fingerprint = null;
          s.unknown = false;
        }
      },
    }),
    [],
  );
}

/**
 * SA-715: the server answered "this key already made an order" with a DIFFERENT cart or kind (draft vs
 * real). The order EXISTS: the modal opens it. It must NEVER mint a new key and resubmit - that is the
 * double order this fix exists to stop. Returns the holding order's id, or null for any other error.
 */
export function idempotencyConflictOrderId(err: unknown): string | null {
  const r = (err as { response?: { status?: number; data?: { code?: string; orderId?: string } } })
    ?.response;
  if (r?.status !== 409) return null;
  const code = r.data?.code;
  const hit =
    code === API_ERROR_CODES.IDEMPOTENCY_KEY_CART_MISMATCH ||
    code === API_ERROR_CODES.IDEMPOTENCY_KEY_DRAFT_MISMATCH;
  return hit && r.data?.orderId ? r.data.orderId : null;
}
