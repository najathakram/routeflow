/**
 * Pure gate for the operator order builder's two save paths, mirroring web's
 * CreateOrderModal footer: a normal submit ("Create Order") needs a customer AND
 * ≥1 item; "Save as Draft" needs only a customer (the API allows a zero-item
 * DRAFT — orders.service `create()` skips the item-count check when
 * `status === "DRAFT"`). Screen-free so __tests__/*.test.ts can lock it.
 */
export interface OrderSubmitGate {
  ok: boolean;
  title?: string;
  message?: string;
}

export function orderSubmitGate(opts: {
  hasCustomer: boolean;
  itemCount: number;
  asDraft: boolean;
}): OrderSubmitGate {
  if (!opts.hasCustomer) {
    return { ok: false, title: "Pick a customer", message: "Choose a customer before saving." };
  }
  if (!opts.asDraft && opts.itemCount === 0) {
    return {
      ok: false,
      title: "Add at least one item",
      message: "Tap + on any product to start the order, or save it as a draft.",
    };
  }
  return { ok: true };
}

/** One parked line's product fetch, settled (F30 · R5). */
export type ResumeLineFetch<P> =
  { ok: true; product: P } | { ok: false; status?: number | null | undefined };

export interface ResumeLineDecision<P> {
  /** The product to hydrate the line with; `null` drops the line. */
  product: P | null;
  /** True = abort the WHOLE hydration (transient failure); never drop lines. */
  failed: boolean;
}

/**
 * What resume hydration does with one parked catalog line (F30 · R5, REG-B195).
 *
 * Three outcomes, and only one of them removes anything:
 *  - fetched OK → KEEP the product, **archived included**. `/products/:id`
 *    returns an `isActive:false` row (unlike the catalog list, which filters
 *    them out), and the barcode ladder resolves archived products too — so a
 *    line scanned into a draft and parked used to come back as "no longer in
 *    your catalog" and vanish. An archived product is still orderable
 *    server-side; the row flags itself instead of deleting the operator's work.
 *  - 404 → DROP: the product is genuinely gone.
 *  - anything else (timeout, 5xx, offline) → FAILED: abort hydration and keep
 *    the spinner, so autosave can never PATCH a truncated cart over the draft.
 */
export function decideResumeLine<P>(fetched: ResumeLineFetch<P>): ResumeLineDecision<P> {
  if (fetched.ok) return { product: fetched.product, failed: false };
  return { product: null, failed: fetched.status !== 404 };
}
