/**
 * SA-824 (d): the ONE submit-attempt rule for a draft-backed write (the Create Order modal today; mobile's order screen can
 * adopt it). One attempt = one `Idempotency-Key`, and at most one request in flight. Pure: no React, no DOM, no network; the
 * caller classifies the server's answer (`SubmitOutcome`) and this decides what happens to the key.
 *
 * Key lifecycle (lead ruling, BUG-A): minted when the form opens; re-minted ONLY after a KNOWN outcome (2xx, or a definitive 4xx
 * refusal that wrote nothing) or when the cart changed with nothing in flight and no unknown outcome; KEPT after an UNKNOWN
 * outcome (no response / timeout / 5xx) even if the cart is then edited. A precondition 4xx the form resolves and re-submits
 * itself is the SAME attempt: keep. SA-817 (A) 4: a key resumed from a draft is `adopted` (an earlier session may have used
 * it), so a cart edit never re-mints it; `onChange` says when a re-mint changed what the draft must carry.
 */
export type SubmitOutcome = "success" | "refused" | "unknown" | "same-attempt" | "conflict";

interface State {
  key: string;
  fingerprint: string | null;
  inFlight: boolean;
  unknown: boolean;
  /** The key came from a resumed draft: an earlier session may already have used it, so a cart edit must not re-mint it. */
  adopted: boolean;
  /** A request has been sent with this key (this session): an order may already exist under it. */
  sent: boolean;
}

const fresh = (key: string): State => ({
  key,
  fingerprint: null,
  inFlight: false,
  unknown: false,
  adopted: false,
  sent: false,
});

export function createSubmitAttempt(mint: () => string, onChange?: (key: string) => void) {
  let s = fresh(mint());
  return {
    /** Every open of the form is a fresh cart session: a new key, announced. */
    reset(): void {
      s = fresh(mint());
      onChange?.(s.key);
    },
    /** The key the draft carries right now (what the next attempt would send, unless the cart changes first). */
    peek(): string {
      return s.key;
    },
    /**
     * A resumed draft brings its own key: use it, so a resubmit after a reload replays the original attempt. Nothing is in
     * flight yet, and a key only ever comes from the SAME draft (the server refuses one that is on another).
     */
    adopt(key: string, opts?: { fresh?: boolean }): void {
      if (s.key === key) return;
      s.key = key;
      s.fingerprint = null;
      s.unknown = false;
      // a brand-new key (a forked copy) has never been used; a key that came from a draft may have been
      s.adopted = !opts?.fresh;
      s.sent = false;
      onChange?.(key);
    },
    /** The key for this attempt, or null when one is already in flight (the caller must not send). */
    begin(fingerprint: string): string | null {
      if (s.inFlight) return null;
      if (!s.unknown && !s.adopted && s.fingerprint !== null && s.fingerprint !== fingerprint) {
        s.key = mint(); // a plain cart edit with nothing in flight
        s.sent = false;
        onChange?.(s.key);
      }
      s.fingerprint = fingerprint;
      s.inFlight = true;
      s.sent = true;
      return s.key;
    },
    /**
     * An order may already exist under the current key: a request was sent with it, an earlier attempt ended unknown, or it came
     * from a resumed draft (an earlier session may have used it). Such a key must never be dropped or moved to another draft.
     */
    maybeUsed(): boolean {
      return !!(s.unknown || s.sent || s.adopted);
    },
    /** An earlier attempt ended unknown and no 2xx or key-conflict has resolved it since. */
    hasUnknown(): boolean {
      return s.unknown;
    },
    /** Release the latch and apply the outcome to the key. */
    settle(outcome: SubmitOutcome): void {
      s.inFlight = false;
      if (outcome === "unknown") {
        s.unknown = true;
      } else if (outcome === "refused" && (s.unknown || s.adopted)) {
        // A 4xx on a RETRY proves only that the retry wrote nothing: the earlier attempt may have.
        // Release the latch and keep the key. Only a 2xx or a coded key-conflict clears `unknown`.
      } else if (outcome === "success" || outcome === "refused" || outcome === "conflict") {
        s.key = mint();
        s.fingerprint = null;
        s.unknown = false;
        s.adopted = false;
        s.sent = false;
        onChange?.(s.key);
      }
    },
  };
}

export type SubmitAttempt = ReturnType<typeof createSubmitAttempt>;
