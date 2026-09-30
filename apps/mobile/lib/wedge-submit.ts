/**
 * Wedge-scanner submit path — extraction target for F30 (fix card:
 * F30-mobile-scan-loss, R3). Pure logic, no RN dependency, shared by the
 * order builders (NewOrderScreen, invoices/new) and the operator item
 * picker (edit-items.tsx).
 *
 * REG-B193: a hardware scanner's Enter-terminated burst used to early-return
 * on a busy flag while the search field was cleared only on a successful
 * ACCEPT — so a second burst arriving mid-resolve typed into the still
 * populated field, and the eventual submit resolved "<code1><code2>" as one
 * garbage code (NewOrderScreen.tsx:1089,1131-1145). The fix: clear the field
 * SYNCHRONOUSLY on every SCAN submit (exactly web's CreateOrderModal.tsx
 * :310-316) and BUFFER — never drop, never concatenate — a submit that
 * arrives while a previous one is still resolving. The clear is gated on the
 * same `looksLikeScanCode` test the resolve path uses, so submitting a typed
 * product NAME leaves the operator's search text (and the filtered list) alone.
 *
 * REG-B201: the settled-search auto-add effect used to guard re-fires with an
 * 800ms same-code time window; a background refetch that re-settles for a
 * code already satisfied — well past the window — re-added the product with
 * no new scan. The fix: a per-scan NONCE. `start()` marks the beginning of a
 * scan attempt; `shouldAutoAdd` may fire at most once per nonce, no matter
 * how late a stale settle for that attempt arrives, and a nonce that has been
 * superseded by a newer attempt never fires at all.
 */
import { looksLikeScanCode } from "./wedge-scan";

export interface WedgeSubmitDeps {
  /** Resolve one code end-to-end (scan-ladder + accept). Never called with a concatenated code. */
  scan: (code: string) => Promise<void>;
  /** Clear the search field. Called synchronously by the returned handler on every SCAN submit. */
  clearSearch: () => void;
}

interface QueuedSubmit {
  code: string;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Build the wedge-submit handler: clears the field synchronously whenever the
 * term is a SCAN code, then either resolves it immediately (nothing else in
 * flight) or queues it (never drops, never concatenates) behind whatever
 * submit is currently being resolved. Queued codes are drained strictly in
 * arrival order, one at a time, once the in-flight resolve finishes.
 *
 * A term that is NOT a scan code is a person typing a product name and
 * pressing Return; `deps.scan` (runWedgeSubmit) already no-ops on it, and the
 * field must survive — wiping it there would reset the filtered product list
 * under the operator.
 */
export function createWedgeSubmitHandler(deps: WedgeSubmitDeps): (term: string) => Promise<void> {
  let busy = false;
  const queue: QueuedSubmit[] = [];

  const drain = async (): Promise<void> => {
    if (busy) return;
    const next = queue.shift();
    if (!next) return;
    busy = true;
    try {
      await deps.scan(next.code);
      next.resolve();
    } catch (err) {
      next.reject(err);
    } finally {
      busy = false;
      // Keep draining: another burst may have queued while this one resolved.
      void drain();
    }
  };

  return function submitWedge(term: string): Promise<void> {
    // Clear BEFORE the resolve is awaited (R3) — but only for a real scan, and
    // on the same test the resolve path gates on, so the two can never disagree.
    if (looksLikeScanCode(term)) deps.clearSearch();
    return new Promise<void>((resolve, reject) => {
      queue.push({ code: term, resolve, reject });
      void drain();
    });
  };
}

/** Tracks the active scan attempt so a stale async settle can't fire twice. */
export interface AutoAddGuard {
  /** Call when a new scan attempt begins; returns its nonce. */
  start: () => number;
  /** Call when a settled search wants to auto-add for `nonce`. */
  shouldAutoAdd: (nonce: number) => boolean;
}

export function createAutoAddGuard(): AutoAddGuard {
  let currentNonce = 0;
  let consumedNonce: number | null = null;
  return {
    start: () => {
      currentNonce += 1;
      return currentNonce;
    },
    shouldAutoAdd: (nonce: number) => {
      // A nonce from a superseded (older or unknown) attempt never fires.
      if (nonce !== currentNonce) return false;
      // The current attempt may auto-add exactly once — a later settle for
      // the SAME attempt (a refetch re-settling) is a phantom, not a scan.
      if (consumedNonce === nonce) return false;
      consumedNonce = nonce;
      return true;
    },
  };
}

/**
 * Per-code attempt bookkeeping around an {@link AutoAddGuard}, shared by the
 * three settled-auto-add effects (NewOrderScreen, invoices/new, edit-items) so
 * they cannot drift.
 *
 * A nonce belongs to a scan ATTEMPT, not to a code. The attempt ENDS when the
 * search field goes empty — which is exactly what an accepted scan does — so
 * the next arrival of a code starts a fresh attempt even when it is the SAME
 * code. Minting only "when the code changes" would instead swallow every
 * deliberate re-scan of an item for the lifetime of the screen (scan the same
 * SKU twice to add two units and the second scan silently adds nothing) — a
 * quiet under-count, i.e. the very scan loss F30 exists to close.
 */
export interface ScanAttempt {
  /** A settled exact match for `code` wants to auto-add: may it? */
  shouldAutoAdd: (code: string) => boolean;
  /** The field went empty / stopped looking like a scan — this attempt is over. */
  end: () => void;
}

export function createScanAttempt(guard: AutoAddGuard = createAutoAddGuard()): ScanAttempt {
  let current: { code: string; nonce: number } = { code: "", nonce: 0 };
  return {
    shouldAutoAdd: (code) => {
      if (current.code !== code) current = { code, nonce: guard.start() };
      return guard.shouldAutoAdd(current.nonce);
    },
    end: () => {
      current = { code: "", nonce: 0 };
    },
  };
}
