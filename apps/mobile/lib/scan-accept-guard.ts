/**
 * Cross-mechanism claim shared between the scan ladder (`scan-ladder.ts`) and
 * a screen's settled-search auto-add effect, so one input event yields
 * exactly one add.
 *
 * THE PROBLEM (F30 open interleavings A/A'/B, hunt 2026-09-14): a screen's
 * camera path and its settled-search-effect path both resolve the SAME
 * physical scan independently — the camera via the ladder's local fast path
 * or server resolve, the effect via `findExactScanMatch` over rows that
 * settled a moment later. Nothing links the two, so either both add (a
 * double-add) or the ladder ends in `notFound`/abort/network-error while the
 * effect already added the line, and the operator sees a false
 * `No product for "X"` pill for an item that's already on the order.
 *
 * THE FIX IS NOT A CODE OR TIME WINDOW. A guard keyed on "this code was
 * accepted recently" would swallow a DELIBERATE re-scan of the same physical
 * item — exactly the under-count `scan-loop.ts`'s 600ms cooldown exists to
 * avoid, and exactly the 800ms window REG-B201 deleted from `wedge-submit.ts`.
 * Instead this holds ONE claim, alive only between `begin()` (one input event
 * entering the ladder) and that same invocation's `settle()`. While the claim
 * is open, the other mechanism's `offer()` for the SAME label parks its match
 * on the claim instead of adding; `settle()` redeems the parked match only
 * when the ladder itself did not resolve (`"unresolved"`) and discards it
 * otherwise. A claim never survives its own settle, and nothing here
 * remembers a code across scans — a second `begin()` for the identical code
 * is a brand new claim and adds independently.
 *
 * Label identity is the same normalizeScanCode candidate-SET intersection
 * `scan-loop.ts#gateScan` uses, so a UPC-A in the box and the EAN-13 the
 * camera decodes for the same physical label are one claim.
 */
import { normalizeScanCode } from "./barcode-normalize";

/** Do two decoded/typed strings denote the same physical label? */
export function sameScanCode(a: string, b: string): boolean {
  const setA = new Set(normalizeScanCode(a).map((c) => c.toUpperCase()));
  if (setA.size === 0) return false;
  return normalizeScanCode(b).some((c) => setA.has(c.toUpperCase()));
}

/** How a single ladder invocation ended. */
export type ScanAcceptResolution = "accepted" | "refused" | "unresolved";

/** A settled-search match parked while a claim for the same label was open. */
export interface DeferredAccept<T> {
  code: string;
  product: T;
  unitKind: "case" | "piece";
}

export interface ScanClaim<T> {
  readonly code: string;
  /**
   * Close the claim. Returns the parked match to redeem (only when
   * `resolution === "unresolved"` and this claim still holds something), or
   * null.
   *
   * A claim owns whatever was parked on it, even after a later `begin()` for a
   * DIFFERENT label supersedes it: that claim's own ladder invocation still
   * ends, and the match the settled list found for ITS code must be redeemed
   * rather than dropped on the floor as a false miss. A superseding claim for
   * the SAME label instead TAKES the parked match at `begin()` time, so exactly
   * one of the two can ever redeem it. Idempotent either way: a second call, or
   * a call on a claim whose match was taken, returns null.
   */
  settle: (resolution: ScanAcceptResolution) => DeferredAccept<T> | null;
}

export interface ScanAcceptGuard<T> {
  /** One input event enters the ladder. */
  begin: (code: string) => ScanClaim<T>;
  /**
   * The settled-search effect has an exact match. Returns true when it
   * should accept now (no open claim for this label — a different item, or
   * nothing in flight); returns false when it was parked on the open claim
   * for this same label instead.
   */
  offer: (code: string, product: T, unitKind: "case" | "piece") => boolean;
}

export function createScanAcceptGuard<T>(): ScanAcceptGuard<T> {
  let open: { code: string; deferred: DeferredAccept<T> | null } | null = null;

  const begin = (code: string): ScanClaim<T> => {
    const mine: { code: string; deferred: DeferredAccept<T> | null } = { code, deferred: null };
    // A superseding claim for the SAME label must never silently drop an
    // already-parked match: it TAKES it (the donor is emptied in the same
    // step, so the two claims can never both redeem it).
    if (open && open.deferred && sameScanCode(open.code, code)) {
      mine.deferred = open.deferred;
      open.deferred = null;
    }
    open = mine;

    const settle = (resolution: ScanAcceptResolution): DeferredAccept<T> | null => {
      // Read and clear THIS claim's own parked match first — a claim
      // superseded by a begin() for a different label keeps holding what was
      // parked on it, and dropping that here is the false-miss bug. Clearing
      // is what makes a second settle() (and a redeem after supersession) a
      // no-op.
      const deferred = mine.deferred;
      mine.deferred = null;
      // Only the CURRENT claim closes the open slot; a superseded one must
      // leave the live claim alone.
      if (open === mine) open = null;
      return resolution === "unresolved" ? deferred : null;
    };

    return { code, settle };
  };

  const offer = (code: string, product: T, unitKind: "case" | "piece"): boolean => {
    if (!open || !sameScanCode(open.code, code)) return true;
    open.deferred = { code, product, unitKind };
    return false;
  };

  return { begin, offer };
}
