import { useEffect, useRef, useState } from "react";
import type { StockCountMode } from "./stock-count-logic";

/**
 * Debounced per-line autosave for a durable stock-count session (PR-C),
 * mirroring `lib/use-draft-autosave.ts`'s 900ms-idle, claim-before-await
 * shape but adapted to a line-addressable API instead of one JSON blob:
 * `PUT /inventory/stock-counts/:id/lines` upserts ONE product's line per
 * call, and the server distinguishes two write kinds
 * (`apps/api/src/inventory/dto/stock-count-session.dto.ts`):
 *
 * - `increment: true` — ADDS to the line's existing counted qty. This is the
 *   live-scan path: every scan bumps the line, and it stays additive (rather
 *   than the client recomputing + sending an absolute total) so a future
 *   second counter on the same session composes correctly instead of
 *   stomping the other's scans. NOT idempotent — a dropped-then-retried
 *   increment must resend the exact same delta, never double it.
 * - `increment` absent — REPLACES the line's counted qty with the given
 *   absolute total. This is the review screen's inline edit (and the scan
 *   screen's manual qty stepper / mode toggle / undo correction): the
 *   caller always passes the complete desired state, so retries and
 *   coalesced debounces are naturally idempotent.
 *
 * The screen's local `rows` state is the single source of truth for "what is
 * the count right now" — scans, edits and undos all update it directly and
 * synchronously. This queue is purely a transport optimization: it batches
 * whatever changed since the last flush into the fewest network calls, using
 * the increment/absolute distinction to pick the right payload shape per
 * line. Every write stays queued (and counted in `pendingCount`, the "n
 * unsaved" badge) until the server actually accepts it — a failed flush
 * merges the failure back in for the next attempt, so nothing is silently
 * dropped on a bad connection.
 */

export type StockCountEditPatch = {
  countedQty?: number;
  boxes?: number;
  pieces?: number;
  unitCostOverride?: number | null;
};

export interface StockCountLineWritePayload {
  productId: string;
  countedQty?: number;
  boxes?: number;
  pieces?: number;
  increment?: boolean;
  mode?: StockCountMode;
  unitCostOverride?: number | null;
}

type PendingEntry =
  | { kind: "increment"; delta: number; mode: StockCountMode }
  | { kind: "edit"; patch: StockCountEditPatch; mode: StockCountMode }
  | { kind: "remove" };

export interface StockCountAutosaveDeps {
  /** PUT /inventory/stock-counts/:id/lines. */
  upsertLine: (payload: StockCountLineWritePayload) => Promise<unknown>;
  /** DELETE /inventory/stock-counts/:id/lines/:productId. */
  removeLine: (productId: string) => Promise<unknown>;
  /** Idle time before pending writes flush. Defaults to 900ms. */
  debounceMs?: number;
  /** Best-effort observability for a write that failed; the queue already
   * retries on the next flush, so this is for logging/toasting only. */
  onError?: (err: unknown, productId: string) => void;
}

export const STOCK_COUNT_AUTOSAVE_DEBOUNCE_MS = 900;

export interface StockCountAutosave {
  /** Accumulate a scan's contribution (+delta pieces) for `productId`. Coalesces
   * with any other unflushed scans for the same product into one increment
   * call. A zero delta is a no-op (never dirties the line). */
  queueScan(productId: string, delta: number, mode: StockCountMode): void;
  /**
   * Replace the line's queued state with an absolute edit. `patch` must be
   * the COMPLETE desired values for whatever fields it sets (not a diff) —
   * this is what makes coalescing repeated edits and retrying a failed one
   * safe: the latest call always wins outright, superseding any earlier
   * queued increment OR edit for this product.
   */
  queueEdit(productId: string, patch: StockCountEditPatch, mode: StockCountMode): void;
  /** Queue a line removal, superseding anything else pending for it. */
  queueRemove(productId: string): void;
  /** Cancel the debounce timer and flush every pending line now. Individual
   * line failures are retried on the next flush, not thrown. */
  flush(): Promise<void>;
  /** Cancels the pending timer without discarding queued writes — call from
   * unmount; a later remount's flush() (or the next queue* call) still sends
   * them. Pending writes are only ever lost by a successful flush. */
  dispose(): void;
  readonly pendingCount: number;
  /** The React wrapper's re-render channel; tests don't need this. */
  onPendingChange(listener: ((n: number) => void) | null): void;
}

export function createStockCountAutosave(deps: StockCountAutosaveDeps): StockCountAutosave {
  const pending = new Map<string, PendingEntry>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let listener: ((n: number) => void) | null = null;

  function notify() {
    listener?.(pending.size);
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm() {
    clearTimer();
    if (disposed) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, deps.debounceMs ?? STOCK_COUNT_AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * A flush attempt for `productId` failed. If nothing new was queued for it
   * meanwhile, just restore what we tried to send. If something newer WAS
   * queued while the request was in flight, that newer entry already
   * supersedes the failed one (increments merge their deltas so no scan is
   * lost; a newer edit/remove is a complete state that already accounts for
   * everything up to it, so the failed write is simply moot).
   */
  function mergeBack(productId: string, failed: PendingEntry) {
    const current = pending.get(productId);
    if (!current) {
      pending.set(productId, failed);
      return;
    }
    if (failed.kind === "increment" && current.kind === "increment") {
      pending.set(productId, { ...current, delta: current.delta + failed.delta });
    }
    // Any other combination: `current` is newer and already complete — drop.
  }

  async function flushOne(productId: string, entry: PendingEntry): Promise<void> {
    try {
      if (entry.kind === "remove") {
        await deps.removeLine(productId);
      } else if (entry.kind === "increment") {
        if (entry.delta === 0) return;
        await deps.upsertLine({
          productId,
          countedQty: entry.delta,
          increment: true,
          mode: entry.mode,
        });
      } else {
        await deps.upsertLine({ productId, mode: entry.mode, ...entry.patch });
      }
    } catch (err) {
      mergeBack(productId, entry);
      deps.onError?.(err, productId);
    }
  }

  async function flush(): Promise<void> {
    clearTimer();
    // Claim every entry BEFORE awaiting (mirrors the draft engine's create
    // latch): a queue* call that arrives while these requests are in flight
    // starts a fresh entry rather than racing this snapshot.
    const entries = Array.from(pending.entries());
    for (const [productId] of entries) pending.delete(productId);
    notify();
    await Promise.all(entries.map(([productId, entry]) => flushOne(productId, entry)));
    notify();
  }

  return {
    queueScan(productId, delta, mode) {
      if (disposed || delta === 0) return;
      const current = pending.get(productId);
      const nextDelta = current?.kind === "increment" ? current.delta + delta : delta;
      pending.set(productId, { kind: "increment", delta: nextDelta, mode });
      notify();
      arm();
    },
    queueEdit(productId, patch, mode) {
      if (disposed) return;
      pending.set(productId, { kind: "edit", patch, mode });
      notify();
      arm();
    },
    queueRemove(productId) {
      if (disposed) return;
      pending.set(productId, { kind: "remove" });
      notify();
      arm();
    },
    flush,
    dispose() {
      disposed = true;
      clearTimer();
    },
    get pendingCount() {
      return pending.size;
    },
    onPendingChange(l) {
      listener = l;
    },
  };
}

export interface UseStockCountAutosaveOptions {
  upsertLine: StockCountAutosaveDeps["upsertLine"];
  removeLine: StockCountAutosaveDeps["removeLine"];
  debounceMs?: number;
  onError?: StockCountAutosaveDeps["onError"];
}

export interface StockCountAutosaveHandle {
  queueScan: StockCountAutosave["queueScan"];
  queueEdit: StockCountAutosave["queueEdit"];
  queueRemove: StockCountAutosave["queueRemove"];
  flush: () => Promise<void>;
  /** Number of lines with a write not yet confirmed by the server — the "n
   * unsaved" badge. */
  pendingCount: number;
}

/** React wrapper: one engine per mount. `upsertLine`/`removeLine` are
 * captured once (they close over the live mutation regardless), matching
 * `useDraftAutosave`'s engine-per-mount contract. */
export function useStockCountAutosave(
  options: UseStockCountAutosaveOptions,
): StockCountAutosaveHandle {
  const { upsertLine, removeLine, debounceMs, onError } = options;

  const engineRef = useRef<StockCountAutosave | null>(null);
  if (!engineRef.current) {
    engineRef.current = createStockCountAutosave({ upsertLine, removeLine, debounceMs, onError });
  }
  const engine = engineRef.current;

  const [pendingCount, setPendingCount] = useState(engine.pendingCount);

  useEffect(() => {
    engine.onPendingChange(setPendingCount);
    return () => engine.onPendingChange(null);
  }, [engine]);

  // Cancels the timer only — any writes still queued when the screen
  // unmounts stay in the map and are picked up by the caller's own
  // best-effort flush() (back handler / AppState background listener), which
  // runs before this cleanup on every path that matters.
  useEffect(() => () => engine.dispose(), [engine]);

  return {
    queueScan: engine.queueScan,
    queueEdit: engine.queueEdit,
    queueRemove: engine.queueRemove,
    flush: engine.flush,
    pendingCount,
  };
}
