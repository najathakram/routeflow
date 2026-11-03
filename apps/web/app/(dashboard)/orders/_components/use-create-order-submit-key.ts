import * as React from "react";
import { API_ERROR_CODES } from "@routeflow/types";
import { createSubmitAttempt, type SubmitOutcome } from "@routeflow/types/submit-attempt";

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
 *
 * SA-817 (A) 4: the key is no longer private to the modal instance. It is persisted with the draft (`payload._submitKey`, local
 * mirror and server `SaleDraft`), so a reload or a killed tab followed by a resubmit replays the SAME key. `peek()` is what the
 * draft carries; `adopt()` seeds the key from a resumed draft; `onChange` says when a re-mint changed what the draft must carry.
 */
export type { SubmitOutcome };

export function mintSubmitKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * No response at all, a timeout, a 5xx, or a 409 MERGE_IN_PROGRESS: the server may or may not have
 * written the order. MERGE_IN_PROGRESS is unknown because mapLockError also wraps the fold's
 * POST-commit reconcile, so it can arrive after the merge committed. (LOCK_UNAVAILABLE is a 503.)
 */
export function isUnknownOutcome(err: unknown): boolean {
  const r = (err as { response?: { status?: number; data?: { code?: string } } } | null)?.response;
  const status = r?.status;
  if (status == null || status === 408 || status >= 500) return true;
  return status === 409 && r?.data?.code === API_ERROR_CODES.MERGE_IN_PROGRESS;
}

/**
 * The state machine (the latch and the key bookkeeping) is the ONE shared rule in
 * `@routeflow/types/submit-attempt` (SA-824 d); this hook only holds it across renders, re-keys it on
 * every open, and routes `onChange` to the latest callback.
 */
export function useCreateOrderSubmitKey(isOpen: boolean, onChange?: (key: string) => void) {
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const attempt = React.useRef<ReturnType<typeof createSubmitAttempt> | null>(null);
  if (attempt.current === null) {
    attempt.current = createSubmitAttempt(mintSubmitKey, (key) => onChangeRef.current?.(key));
  }
  // Mint on OPEN: every open of the modal is a fresh cart session.
  React.useEffect(() => {
    if (isOpen) attempt.current!.reset();
  }, [isOpen]);

  return attempt.current;
}

// Not in the shared API_ERROR_CODES (declared next to the code that throws them, merge-idempotency.ts);
// mobile spells them the same way.
const IDEMPOTENCY_KEY_CONFLICT = "IDEMPOTENCY_KEY_CONFLICT"; // reasons CART_MISMATCH / HELD_BY_OTHER_ORDER
const IDEMPOTENCY_REPLAY_NEEDS_RECONCILE = "IDEMPOTENCY_REPLAY_NEEDS_RECONCILE";

/**
 * SA-715: the server answered "this key already made an order" (a different cart, a draft, another
 * order's key, or a replay that needs reconciling). The order EXISTS: the modal opens it. It must
 * NEVER mint a new key and resubmit - that is the double order this fix exists to stop. Returns the
 * holding order's id, or null for any other error. Checked BEFORE the unknown/refused split.
 */
export function idempotencyConflictOrderId(err: unknown): string | null {
  const r = (err as { response?: { status?: number; data?: { code?: string; orderId?: string } } })
    ?.response;
  if (r?.status !== 409) return null;
  const code = r.data?.code;
  const hit =
    code === API_ERROR_CODES.IDEMPOTENCY_KEY_CART_MISMATCH ||
    code === API_ERROR_CODES.IDEMPOTENCY_KEY_DRAFT_MISMATCH ||
    code === IDEMPOTENCY_KEY_CONFLICT ||
    code === IDEMPOTENCY_REPLAY_NEEDS_RECONCILE;
  return hit && r.data?.orderId ? r.data.orderId : null;
}

/** B1201: the copy lives in @routeflow/types (shared with mobile); re-exported for existing imports. */
export { CREDITS_PENDING_COPY } from "@routeflow/types";

/**
 * B1201: 503 ORDER_SAVED_CREDITS_PENDING carries the saved order's id. The order EXISTS, so the modal
 * opens it (credits are applied there) and never resubmits - a replay of the key does not apply credits.
 * Returns that id, or null for any other error.
 */
export function creditsPendingOrderId(err: unknown): string | null {
  const r = (err as { response?: { status?: number; data?: { code?: string; orderId?: string } } })
    ?.response;
  const hit = r?.status === 503 && r.data?.code === API_ERROR_CODES.ORDER_SAVED_CREDITS_PENDING;
  return hit && r?.data?.orderId ? r.data.orderId : null;
}
