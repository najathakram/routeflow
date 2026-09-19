/**
 * F30 / R2 / REG-B192 — ScanCamera's `busyRef` used to be a plain boolean:
 * while a scan resolve was in flight, every further detection was dropped
 * with no feedback, for up to one full lookup (api-client.ts's timeout) per
 * scan — see `.claude/pipeline/fix-cards/F30-mobile-scan-loss.md` B192.
 *
 * This module is that mutex's replacement: a pure, jest-speccable state
 * machine holding a bounded (depth 2) pending queue behind the one code
 * currently resolving, so ScanCamera can buffer instead of drop and
 * ScanOrderSheet can render an `isResolving` indicator.
 *
 * WHO OWNS DEDUPE: `scan-loop.ts`'s gate, and only it. Every detection that
 * reaches `pushScan` was already ACCEPTED there, which for a repeat of the
 * same item means both of its clocks cleared — `SCAN_COOLDOWN_MS` since the
 * last accept AND `ABSENCE_GAP_MS` out of frame — i.e. the operator lifted
 * the item away and deliberately re-presented it, matched on the NORMALIZED
 * candidate set so a label flickering between symbologies is one item. A
 * second dedupe here could only overrule that verdict, and overruling it is
 * exactly B192: scanning the same item twice during one slow lookup landed
 * qty 1. So the buffer keeps EVERY accepted detection, repeats included.
 */

export interface PendingBufferState {
  isResolving: boolean;
  /** The code currently being resolved, or null when idle. */
  current: string | null;
  /**
   * Codes waiting their turn, oldest first. Capped at PENDING_BUFFER_DEPTH.
   * A repeat of a code already here (or of `current`) is a separate deliberate
   * scan and gets its own slot — this is a queue, not a set.
   */
  pending: string[];
}

/** Max codes queued behind the one currently resolving (spec R2). */
export const PENDING_BUFFER_DEPTH = 2;

export interface PendingBufferResult {
  next: PendingBufferState;
  /** The code to hand to the resolver right now, or null to start nothing. */
  startResolving: string | null;
}

/** The empty/idle buffer. */
export function createPendingBuffer(): PendingBufferState {
  return { isResolving: false, current: null, pending: [] };
}

/**
 * A newly-accepted scan arrives. Starts resolving immediately when nothing
 * else is in flight; otherwise buffers it (depth-capped) instead of dropping
 * it — including when it repeats the code currently resolving or one already
 * queued, since the gate has already ruled that repeat deliberate.
 */
export function pushScan(state: PendingBufferState, code: string): PendingBufferResult {
  if (!state.isResolving) {
    return { startResolving: code, next: { isResolving: true, current: code, pending: [] } };
  }
  if (state.pending.length >= PENDING_BUFFER_DEPTH) {
    // Bounded by design (R2's "depth 2") — this is the intentional cap, not
    // the drop-not-queue bug: it only bites once THREE accepted scans (the
    // one resolving plus two buffered) are already in flight at once, which
    // real resolve latency makes rare.
    return { startResolving: null, next: state };
  }
  return { startResolving: null, next: { ...state, pending: [...state.pending, code] } };
}

/**
 * The in-flight resolve finished. Pulls the next buffered code (FIFO) to
 * start resolving, or clears `isResolving` when nothing is left.
 */
export function completeResolve(state: PendingBufferState): PendingBufferResult {
  const [next, ...rest] = state.pending;
  if (next === undefined) {
    return { startResolving: null, next: { isResolving: false, current: null, pending: [] } };
  }
  return { startResolving: next, next: { isResolving: true, current: next, pending: rest } };
}
