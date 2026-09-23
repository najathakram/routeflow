import type { LadderProduct } from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import { buildUnitOptions } from "./unit-options";

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

/** The parked line's own fields `decideResumeUnitPrice` needs — a structural slice of
 *  `DraftCatalogLine`, kept local so this file stays free of a drafts-payload.ts import. */
export interface ResumeUnitLineInput {
  unitLabel?: string | null;
  priceType?: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  unitPrice?: number;
  priceSource?: "history" | "operator";
}

/** One `UnitOption`-shaped price, the only fields this decision reads. */
export interface ResumeUnitOption {
  value: string;
  price: number;
}

export interface ResumeUnitPriceDecision {
  /** Restored unit label — undefined for a plain pack line, or a ladder that lost this level. */
  unitLabel: string | undefined;
  /** The unit's own LIVE price, re-resolved at the CURRENT customer's tier — never the parked
   *  price (a stale tier/list price is never allowed to stick, matching submitOrder's own rule). */
  unitBasePrice: number | undefined;
  /** A genuine operator override, PINNED ON TOP of unitBasePrice — never instead of it. Undefined
   *  when there's no override, or the parked price was only a history pre-fill (B755). */
  operatorUnitPrice: number | undefined;
  /** True when the parked unitLabel no longer matches any level on the live ladder — the line
   *  fell back to the pack. The caller warns; this function never logs. */
  fellBackToPack: boolean;
}

/**
 * B747 (SA-085a) / B755 — what a parked line resumes as, given the LIVE unit options already
 * resolved for its product at the CURRENT customer's tier (`buildUnitOptions` — fetching the
 * ladder and calling it is the caller's job; this stays pure/no-fetch so it can be pinned here).
 *
 * Precedence (SA-085 addition): an explicit operator override beats the live ladder price — it
 * is returned ALONGSIDE `unitBasePrice`, for the caller to layer on top, never in place of it. A
 * history-sourced price (`priceSource === "history"`) is never treated as an override, which is
 * the entire point of B755 — resuming under a different customer must re-price to THAT customer,
 * not silently keep the first customer's remembered price.
 */
export function decideResumeUnitPrice(
  li: ResumeUnitLineInput,
  liveOptions: readonly ResumeUnitOption[],
): ResumeUnitPriceDecision {
  const label = li.unitLabel?.trim() || undefined;
  if (!label) {
    return {
      unitLabel: undefined,
      unitBasePrice: undefined,
      operatorUnitPrice: undefined,
      fellBackToPack: false,
    };
  }
  const match = liveOptions.find((o) => o.value === label);
  if (!match) {
    return {
      unitLabel: undefined,
      unitBasePrice: undefined,
      operatorUnitPrice: undefined,
      fellBackToPack: true,
    };
  }
  const isOperatorOverride =
    li.priceType === "MANUAL" && li.priceSource !== "history" && li.unitPrice != null;
  return {
    unitLabel: label,
    unitBasePrice: match.price,
    operatorUnitPrice: isOperatorOverride ? li.unitPrice : undefined,
    fellBackToPack: false,
  };
}

/** `resolveResumeLinePricing`'s parked-line input — `decideResumeUnitPrice`'s own input plus
 *  the fields its non-unit (B755) branch and fallback-warning message need. */
export interface ResumeLinePricingInput extends ResumeUnitLineInput {
  productId: string;
  productName?: string;
}

export interface ResumeLinePricingResult {
  unitLabel?: string;
  unitBasePrice?: number;
  /** A genuine operator override — from either branch below, always tagged "operator" (a
   *  history-sourced price is never carried across a resume, so it never reaches here). */
  unitPrice?: number;
  /** Set (with nothing else) when a unit-labeled line's ladder lost that level — the caller
   *  should console.warn this and apply NOTHING else from this result (the line resumes as
   *  a plain pack, same as a line with no unitLabel at all). */
  fallbackWarning?: string;
}

/**
 * B747 (SA-085a) / B755 — composes `decideResumeUnitPrice` with the live-ladder lookup
 * (`buildUnitOptions`) and the B755 history-vs-operator branch for a NON-unit line, so
 * NewOrderScreen's hydration effect stays a thin apply-the-result caller (size-ratchet:
 * this used to be inline there). Still pure — `product`/`units` are already fetched by the
 * caller (`hydrateParkedLine` in `./resume-draft-hydration.ts` does the fetch).
 */
export function resolveResumeLinePricing(
  li: ResumeLinePricingInput,
  product: LadderProduct,
  units: readonly ProductUnitLevel[],
  customerTier: number | string,
): ResumeLinePricingResult {
  if (li.unitLabel) {
    const decision = decideResumeUnitPrice(li, buildUnitOptions(product, units, customerTier));
    if (decision.fellBackToPack) {
      return {
        fallbackWarning: `[NewOrderScreen] resume: "${li.unitLabel}" no longer exists on ${li.productName || li.productId}'s ladder — falling back to the pack.`,
      };
    }
    const result: ResumeLinePricingResult = {
      unitLabel: decision.unitLabel,
      unitBasePrice: decision.unitBasePrice,
    };
    if (decision.operatorUnitPrice != null) result.unitPrice = decision.operatorUnitPrice;
    return result;
  }
  if (li.priceType === "MANUAL" && li.priceSource !== "history" && li.unitPrice != null) {
    return { unitPrice: li.unitPrice };
  }
  return {};
}
