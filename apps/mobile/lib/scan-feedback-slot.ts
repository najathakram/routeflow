/**
 * The scan sheet's feedback-pill state machine, lifted out of
 * `components/ScanOrderSheet.tsx` so it runs in the node Jest lane.
 *
 * THE DEFECT THIS EXISTS TO CLOSE (hunt 2026-09-14,
 * `scanordersheet-stale-error-pill-lingers-over-next-add`): the sheet used to
 * write the pill from ONE branch only — `handleOutcome` called `showError` on
 * an `error` outcome and the success branch never touched `error`. A scan
 * miss therefore left `No product for "X"` — with a LIVE `Create` button —
 * sitting over the camera for the rest of its 8000ms actionable lifetime,
 * across however many items scanned fine in the meantime. The operator is
 * told an item is missing at the exact moment it landed in the tray, and the
 * button they tap creates a product for a code that is already on the order.
 *
 * Every accept path makes that worse rather than better: `acceptScannedProduct`
 * returns `undefined` while the sheet is open ("the tray row is the
 * confirmation"), so the success outcome carries no feedback of its own to
 * overwrite the stale error with.
 *
 * THE RULE, and the only behavioural change: a settled outcome ALWAYS owns the
 * slot. An error shows its pill; anything else — an accept, a hand-off close,
 * a bare `undefined` — CLEARS it. A pill can only ever describe the most
 * recent scan.
 *
 * Pure by construction: no React, no react-native, no timers. The host owns
 * the `setTimeout` (keyed on {@link ScanFeedbackSlotState.nonce}, so a new
 * pill cancels the previous pill's expiry instead of inheriting it) and the
 * haptics/scroll named by {@link scanSlotEffects}.
 */
import type { ScanFeedback, ScanOutcome } from "./scan-loop";

/** A plain (non-actionable) error pill: long enough to read. */
export const ERROR_PILL_MS = 2600;
/** An actionable pill has to survive long enough to be read AND tapped. */
export const ACTION_PILL_MS = 8000;

export interface ScanFeedbackSlotState {
  /** The pill to render, or null for no pill. */
  pill: ScanFeedback | null;
  /** How long `pill` may live. Null whenever there is no pill to expire. */
  ttlMs: number | null;
  /**
   * Climbs on every transition. The host keys its expiry timer on this, so an
   * outcome that replaces (or clears) a pill also invalidates the timer that
   * was going to clear the previous one — and a late `expire` for a nonce that
   * has already moved on is ignored rather than wiping a fresher pill.
   */
  nonce: number;
}

export const INITIAL_SCAN_SLOT: ScanFeedbackSlotState = { pill: null, ttlMs: null, nonce: 0 };

export type ScanSlotAction =
  /** A scan settled. The outcome owns the slot, whatever it is. */
  | { type: "outcome"; outcome: ScanOutcome }
  /** The operator tapped the pill's action button. */
  | { type: "dismiss" }
  /** The sheet closed — the next open must not inherit this pill. */
  | { type: "reset" }
  /** The host's timer for `nonce` fired. */
  | { type: "expire"; nonce: number };

/**
 * What the host must DO about an outcome, beyond rendering the slot. Split
 * from the state so `handleOutcome` can dispatch through a functional
 * `setState` (burst-safe) while still running the effects exactly once.
 */
export type ScanSlotEffect =
  /** Error haptic. */
  | "error-cue"
  /** Accept haptic (plus the web vibrate fallback — no haptics on RN Web). */
  | "added-cue"
  /** Bring the newest tray row into view. */
  | "scroll-tray-top"
  /** `{ close: true }` — the caller is handing off and replaces the scanner. */
  | "close-sheet";

function isError(outcome: ScanOutcome): outcome is { feedback: ScanFeedback } {
  return outcome?.feedback?.kind === "error";
}

/** Lifetime of a pill: actionable pills must outlive the time it takes to tap. */
export function pillTtlMs(feedback: ScanFeedback): number {
  return feedback.action ? ACTION_PILL_MS : ERROR_PILL_MS;
}

export function scanSlotEffects(outcome: ScanOutcome): readonly ScanSlotEffect[] {
  if (isError(outcome)) return ["error-cue"];
  if (outcome?.close) return ["close-sheet"];
  return ["added-cue", "scroll-tray-top"];
}

export function reduceScanSlot(
  state: ScanFeedbackSlotState,
  action: ScanSlotAction,
): ScanFeedbackSlotState {
  switch (action.type) {
    case "outcome": {
      if (isError(action.outcome)) {
        const feedback = action.outcome.feedback;
        return { pill: feedback, ttlMs: pillTtlMs(feedback), nonce: state.nonce + 1 };
      }
      // THE FIX: a success (or a hand-off close) clears whatever was there.
      // Without this the previous scan's miss pill outlives the add.
      if (state.pill === null) return state;
      return { pill: null, ttlMs: null, nonce: state.nonce + 1 };
    }
    case "dismiss":
    case "reset": {
      if (state.pill === null) return state;
      return { pill: null, ttlMs: null, nonce: state.nonce + 1 };
    }
    case "expire": {
      // A stale timer (its pill was already replaced or cleared) must not
      // wipe the pill that replaced it.
      if (action.nonce !== state.nonce || state.pill === null) return state;
      return { pill: null, ttlMs: null, nonce: state.nonce + 1 };
    }
  }
}
