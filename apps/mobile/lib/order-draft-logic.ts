import { normalizeBoxesPieces, type LadderProduct } from "@routeflow/pricing";
import type { ProductUnitLevel } from "@routeflow/types";
import { buildUnitOptions } from "./unit-options";
import { isFamilyProduct } from "./sellable-products";

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
 *  - 404 → DROP: the product is genuinely gone. A FAMILY container also drops (never orderable).
 *  - anything else (timeout, 5xx, offline) → FAILED: abort hydration and keep
 *    the spinner, so autosave can never PATCH a truncated cart over the draft.
 */
export function decideResumeLine<P>(fetched: ResumeLineFetch<P>): ResumeLineDecision<P> {
  // A FAMILY container is never orderable (400 FAMILY_NOT_SELLABLE): a restored draft drops it instead of queuing it.
  if (fetched.ok) {
    if (isFamilyProduct(fetched.product as { kind?: "FAMILY" } | null)) {
      return { product: null, failed: false };
    }
    return { product: fetched.product, failed: false };
  }
  return { product: null, failed: fetched.status !== 404 };
}

/**
 * B747 REQUIRED fix (Opus @267fb9f0, disagreeing with SA-153's PASS): whether NewOrderScreen's
 * resume-hydration effect may start. "waiting": customerDetail or the customer-prices query hasn't
 * SETTLED yet (fetched OR errored — a plan-gated/failed query never resolves `data`, so gating on
 * data alone hung the spinner forever). "failed": prices settled with an error that ISN'T the
 * pricing_tiers plan gate (403) — proceeding would silently resume every line at the customer's
 * default tier even when real per-product overrides exist, so abort exactly like a failed
 * product/units fetch (decideResumeLine's own rule; matches R1). "start": safe to hydrate — a 403
 * genuinely has no overrides (cpMap stays empty, its own `?? []` fallback already handles that).
 * Pure/no-fetch so it can be pinned directly, never scraped from the effect's source text (L-205).
 */
export function decideResumeHydrationStart(
  hasCustomerDetail: boolean,
  pricesFetched: boolean,
  pricesErrored: boolean,
  pricesFetching: boolean,
  pricesErrorStatus: number | null | undefined,
): "waiting" | "start" | "failed" {
  // SA-165: TanStack keeps isError true DURING a refetch, so "errored" alone is not settled — a
  // Retry that re-fires the query must gate back to waiting, never re-fail before the new attempt
  // resolves (else the "couldn't restore" dialog reopens the instant Retry is tapped).
  if (!hasCustomerDetail || !(pricesFetched || pricesErrored) || pricesFetching) return "waiting";
  if (pricesErrored && pricesErrorStatus !== 403) return "failed";
  return "start";
}

/** The parked line's own fields `decideResumeUnitPrice` needs — a structural slice of
 *  `DraftCatalogLine`, kept local so this file stays free of a drafts-payload.ts import. */
export interface ResumeUnitLineInput {
  unitLabel?: string | null;
  priceType?: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  unitPrice?: number;
  priceSource?: "history" | "operator";
  /** #2696(c): the override's reason, re-applied with it (a special line bills it only so). */
  overrideReason?: string;
}

/** One `UnitOption`-shaped price, the only fields this decision reads. */
export interface ResumeUnitOption {
  value: string;
  price: number;
  /** Pieces per one of this unit — CartRow's margin hint basis (unit-options.ts#marginFactorFor). */
  factorToBase: number;
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
  /** W/N (Opus REQUIRED, B747): the unit's pieces-per-unit factor, restored from the LIVE ladder
   *  match — the live picker sets this on every unit pick (NewOrderScreen's unitFactor:
   *  option.factorToBase); resume must too, or CartRow's marginFactorFor falls back to 1 and
   *  prices/costs a Case's margin hint as if it were a single piece. */
  unitFactor: number | undefined;
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
      unitFactor: undefined,
      fellBackToPack: false,
    };
  }
  const match = liveOptions.find((o) => o.value === label);
  if (!match) {
    return {
      unitLabel: undefined,
      unitBasePrice: undefined,
      operatorUnitPrice: undefined,
      unitFactor: undefined,
      fellBackToPack: true,
    };
  }
  const isOperatorOverride =
    li.priceType === "MANUAL" && li.priceSource !== "history" && li.unitPrice != null;
  return {
    unitLabel: label,
    unitBasePrice: match.price,
    operatorUnitPrice: isOperatorOverride ? li.unitPrice : undefined,
    unitFactor: match.factorToBase,
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
  /** #2696(c): the parked override's reason, restored alongside `unitPrice`. */
  overrideReason?: string;
  /** W/N (Opus REQUIRED, B747): CartRow's margin-hint pieces-per-unit basis — see
   *  ResumeUnitPriceDecision.unitFactor. Undefined for a plain pack line (marginFactorFor then
   *  reads the product's own unitsPerBox instead, same as a freshly-picked pack line). */
  unitFactor?: number;
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
      unitFactor: decision.unitFactor,
    };
    if (decision.operatorUnitPrice != null) {
      result.unitPrice = decision.operatorUnitPrice;
      if (li.overrideReason?.trim()) result.overrideReason = li.overrideReason;
    }
    return result;
  }
  if (li.priceType === "MANUAL" && li.priceSource !== "history" && li.unitPrice != null) {
    return {
      unitPrice: li.unitPrice,
      ...(li.overrideReason?.trim() ? { overrideReason: li.overrideReason } : {}),
    };
  }
  return {};
}

/** `resolveResumeLineBoxes`'s parked-line input — a structural slice of `DraftCatalogLine`. */
export interface ResumeLineBoxesInput {
  unitLabel?: string | null;
  boxes?: number;
  pieces?: number;
  qty: number;
  unitsPerBox?: number;
}

export interface ResumeLineBoxesResult {
  boxes?: number;
  pieces?: number;
  qty: number;
}

/**
 * W/N (Opus REQUIRED, B747) — re-derives boxes/pieces/qty when the LIVE product's unitsPerBox
 * differs from the parked snapshot (never keep the stale qty: silent over/under-charge). NEVER
 * for a unit-labeled line — its qty is a plain COUNT of the chosen unit, unrelated to the pack's
 * own box size; re-splitting it would inject boxes/pieces onto a line units_v1 forbids that on.
 */
export function resolveResumeLineBoxes(
  li: ResumeLineBoxesInput,
  liveUnitsPerBox: number,
): ResumeLineBoxesResult {
  let boxes = li.boxes;
  let pieces = li.pieces;
  let qty = li.qty;
  const parkedUpb = Number(li.unitsPerBox ?? 0);
  const liveUpb = Number(liveUnitsPerBox ?? 0);
  if (!li.unitLabel && liveUpb !== parkedUpb) {
    const n = normalizeBoxesPieces({ boxes, pieces, qty, unitsPerBox: liveUpb });
    boxes = n.boxes ?? undefined;
    pieces = n.pieces ?? undefined;
    qty = n.qty;
  }
  return { boxes, pieces, qty };
}
