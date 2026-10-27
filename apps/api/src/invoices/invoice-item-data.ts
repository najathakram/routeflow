/**
 * Order line -> invoice line (the `buildInvoiceItemData` copier). Pure: no collaborator is read. Extracted VERBATIM
 * from InvoicesService (size ratchet, behaviour-neutral); the service keeps a one-line delegate.
 */
import { invoiceCompositionFields } from "./invoice-line-composition";
import { finiteStoredLevy } from "../common/money-invariants.util";
import { computeLineSubtotal, roundMoney, normalizeBoxesPieces } from "@routeflow/pricing";
import { assertIntegerPieces, billPackOf } from "./unit-line-bill-guard";
import { assertUnitLineSplit } from "../orders/unit-line-split";

/**
 * Shared per-line invoice-item shape built from an order line, billing `billQty`
 * pieces of it. Reused by createInvoiceFromOrder, reconcileOrderDraftInvoice and
 * createPartialFromOrder so the invoice line NEVER drifts from the order line.
 *
 * COPY, DON'T RECOMPUTE. The order line already holds the agreed money
 * (`li.subtotal`) and the canonical box/piece denomination (`li.boxes` null ⇒
 * `qty` is in SELLING UNITS, not pieces). Re-deriving either from the billed qty
 * and the LIVE product.unitsPerBox is what let an invoice diverge from its order
 * (a packaging change re-priced past lines; the per-box price showed as the line
 * total). So:
 *   - Money comes from the STORED subtotal, never `computeLineSubtotal(live upb)`.
 *   - The box/piece split is only derived for lines that were themselves stored
 *     with a split (`li.boxes != null`); selling-unit lines keep `boxes = null`.
 *   - `unitsPerBox` is snapshotted so any later recompute (edit form, PDF) uses
 *     the sale-time box size, not the live product.
 *
 * Partial billing uses telescoping cumulative rounding keyed on
 * `opts.priorBilledQty` (the qty already billed by surviving invoices): each
 * bill's subtotal = round(S · (prior+bill)/Q) − round(S · prior/Q). This sums to
 * exactly `S` once the line is fully billed (no per-partial cent drift) and, for
 * a full bill from scratch (prior 0, bill = qty), copies `S` verbatim. On a
 * BUY_N_GET_M line the cumulative key is the PAID qty (raw minus the free units'
 * worth) so the prorated money agrees with the partial's whole-unit free
 * allocation — see the comment at the proration itself.
 */
export function buildInvoiceItemData(
  li: any,
  billQty: number,
  tenantId: string | null,
  opts?: { priorBilledQty?: number; priorPack?: number | null },
) {
  const orderQty = Number(li.qty) || 0;
  const storedSubtotal = li.subtotal != null ? Number(li.subtotal) : null;
  const unitPrice = Number(li.unitPrice);
  const unitsPerBox = billPackOf(li, opts?.priorPack, li.product?.unitsPerBox); // a unit line's OWN pack wins (SA-178)
  const isBoxSplit = li.boxes != null; // stored WITH a box/piece split
  assertIntegerPieces(li, billQty, unitsPerBox); // B652: no fractional pieces on a boxed line

  // Box/piece split for DISPLAY only (money is the stored subtotal). Selling-unit
  // and non-boxed lines keep boxes/pieces null so `qty` stays in whatever unit the
  // order line used — never re-interpreted as pieces.
  const split = isBoxSplit
    ? normalizeBoxesPieces({ qty: billQty, unitsPerBox })
    : { qty: billQty, boxes: null as number | null, pieces: null as number | null };

  const prior = Math.max(0, Number(opts?.priorBilledQty ?? 0));

  // BUY_N_GET_M: the order line's free-unit snapshot travels onto the invoice
  // line, allocated across partials by a CUMULATIVE floor (so Σ(partials) == the
  // order line's free units and a full bill copies it verbatim). The snapshot is
  // what keeps a later DRAFT edit from re-pricing the line to full.
  const storedFreeUnits = Math.max(0, Math.trunc(Number(li.promoFreeUnits ?? 0) || 0));
  const hasFreeUnits = storedFreeUnits > 0 && orderQty > 0;
  // A free unit is a whole SELLING unit: `unitsPerBox` pieces on a box-split line,
  // one qty unit on a selling-unit line.
  const freeUnitSize = isBoxSplit && unitsPerBox > 0 ? unitsPerBox : 1;
  const freeUnitsThrough = (cumQty: number) =>
    Math.min(storedFreeUnits, Math.floor((storedFreeUnits * Math.max(0, cumQty)) / orderQty));
  const promoFreeUnits = !hasFreeUnits
    ? storedFreeUnits
    : freeUnitsThrough(prior + billQty) - freeUnitsThrough(prior);

  // Free units are WHOLE units while the qty axis is pieces, so a subtotal prorated
  // over the raw qty disagrees with the floored free-unit allocation by up to one
  // unit price on a partial — and `update()` re-prices a DRAFT from the stored
  // `promoFreeUnits`, so a no-op re-save would move the money. Prorate over the PAID
  // quantity instead (raw minus the free units' worth): the stored subtotal then
  // equals `computeLineSubtotal(split, promoFreeUnits)` and the round-trip is
  // money-preserving, while Σ(partials) is still exactly the stored subtotal
  // (paid(0) = 0, paid(orderQty) = paidQty). Non-BOGO lines are untouched.
  const paidQty = orderQty - storedFreeUnits * freeUnitSize;
  const onPaidBasis = hasFreeUnits && paidQty > 0;
  const basisQty = onPaidBasis ? paidQty : orderQty;
  const billedThrough = (cumQty: number) =>
    onPaidBasis ? cumQty - freeUnitsThrough(cumQty) * freeUnitSize : cumQty;

  let subtotal: number;
  if (storedSubtotal == null || orderQty <= 0) {
    // Legacy/degenerate line with no stored money: fall back to the shared helper
    // using the STORED split (never a live re-split).
    subtotal = computeLineSubtotal({
      unitPrice,
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox,
      freeUnits: promoFreeUnits,
    });
  } else {
    // Telescoping cumulative rounding — exact and drift-free across partials.
    // F04/REG-B50 oracle-cap check (this lane): CAP each point at basisQty.
    // With freeUnitSize > 1 the floored free-unit allocation (freeUnitsThrough)
    // lands only near 100% delivered, so an uncapped billedThrough can exceed
    // basisQty for a cumQty still short of orderQty — e.g. 2 free boxes of 8
    // (unitsPerBox 6): at cumQty = 47 of 48, freeUnitsThrough floors to 1 (not
    // yet 2), so billedThrough = 47 − 6 = 41 > basisQty 36, and an uncapped
    // partial would bill 41/36 of the line — MORE than its whole agreed
    // subtotal. `prorateLineSubtotal` in the web/mobile pricing.ts mirrors
    // already carry this cap (F04); the reference oracle here did not.
    // Unreachable at freeUnitSize 1 (billedThrough ≤ cumQty ≤ orderQty =
    // basisQty then); a full bill (prior 0, billQty orderQty) still copies the
    // stored subtotal back verbatim since billedThrough(orderQty) === basisQty.
    subtotal = roundMoney(
      roundMoney((storedSubtotal * Math.min(billedThrough(prior + billQty), basisQty)) / basisQty) -
        roundMoney((storedSubtotal * Math.min(billedThrough(prior), basisQty)) / basisQty),
    );
  }

  // RF-4: prorate the line's snapshotted category tax the SAME telescoping way as
  // the subtotal, so a partial / delivered-basis bill collects only its share and
  // Σ(partials) == the order line's full category tax. A full bill from scratch
  // (prior 0, billQty = orderQty) copies the stored amount verbatim. SA-816: non-finite = 400.
  const storedCategoryTax = finiteStoredLevy(li, "Order line category tax");
  const categoryTaxAmount =
    storedCategoryTax === 0 || orderQty <= 0
      ? storedCategoryTax
      : roundMoney(
          roundMoney((storedCategoryTax * (prior + billQty)) / orderQty) -
            roundMoney((storedCategoryTax * prior) / orderQty),
        );

  // #2230: the fields name the line and its id in the 409 / the Sentry report; the call is unchanged.
  const named = { id: li.id, orderItemId: li.id, description: li.product?.name ?? li.name };
  assertUnitLineSplit(
    { ...split, unitLabel: li.unitLabel, unitsPerBox, productId: li.productId, ...named },
    "buildInvoiceItemData",
  );
  return {
    // Catalog lines use the product name; unlisted lines carry a free-text `name`.
    description: li.product?.name ?? li.name ?? `Product`,
    productId: li.productId,
    // Provenance back to the source order line (null for freeform lines).
    orderItemId: li.id ?? null,
    unitLabel: li.unitLabel ?? null, // units_v1: the unit travels with the line
    qty: split.qty,
    boxes: split.boxes,
    pieces: split.pieces,
    unitsPerBox: unitsPerBox > 0 ? unitsPerBox : null,
    promoFreeUnits: promoFreeUnits > 0 ? promoFreeUnits : null,
    // MSRP snapshot — set below by the caller's applyMsrpSnapshots (null when
    // flag.msrp is off for the tenant).
    msrp: null as number | null,
    notes: li.notes ?? null, // the per-line note, verbatim from the order line (buyer-visible)
    unitPrice,
    // `unitPrice` is ALREADY the net (post-override) price: the order stores the override as a reduced unitPrice
    // plus `originalPrice` for the strikethrough. Re-deriving a `discount` from originalPrice double-counts it:
    // every invoice consumer computes `computeLineSubtotal(unitPrice) - discount`, so {unitPrice 90, discount 10}
    // would bill 80 for a 100→90 override. Keep discount 0; `originalPrice` shows the savings (mirrors the order).
    discount: 0,
    originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
    priceType: li.priceType ?? "STANDARD",
    overrideReason: li.overrideReason ?? null, // H3b: verbatim with the override price; STAFF-ONLY
    overriddenBy: li.overriddenBy ?? null, // (never on the buyer portal nor the customer PDF)
    // B294: placeholder — this builder has no order-level context (isTaxExempt,
    // order.tax/order.subtotal), so every caller MUST overwrite this via
    // `applyOrderDerivedTaxRate(itemsData, order, isTaxExempt)` right after
    // calling buildInvoiceItemData. Leaving it at 0 here (as before B294) let
    // applyPriceAdjustment's `Σ li.subtotal * li.taxRate` recompute silently
    // zero the regular tax on any order-derived invoice.
    taxRate: 0,
    subtotal,
    // Phase 4 (W4): carry the line's regulated category onto the invoice line so the split can group by it
    // and reporting/ledger can read it. B297 row 373 (SA-734r2 r-note 8): the order line's own snapshot,
    // VERBATIM. An uncategorised line stays uncategorised (with its stored levy), whatever its product's
    // category is now: the copier never re-files a line under the live product. (A pre-snapshot line is
    // therefore invoiced as the order recorded it; no backfill of OrderItem categories exists today.)
    trackedCategoryId: li.trackedCategoryId ?? null,
    // RF-3: reporting-only subcategory snapshot, mirroring trackedCategoryId (verbatim, never the product's).
    trackedSubcategoryId: li.trackedSubcategoryId ?? null,
    categoryTaxAmount,
    categoryTaxType: li.categoryTaxType ?? null, // B297: COPY verbatim, never a live fallback.
    categoryTaxRate: li.categoryTaxRate != null ? Number(li.categoryTaxRate) : null,
    categoryPriceIncludesTax: li.categoryPriceIncludesTax ?? null,
    restrictionOverrideReason: li.restrictionOverrideReason ?? null, // row 510: the staff override travels
    restrictionOverrideBy: li.restrictionOverrideBy ?? null,
    restrictionOverrideAt: li.restrictionOverrideAt ?? null,
    restrictionOverrideRuleIds: li.restrictionOverrideRuleIds ?? [],
    ...(tenantId ? { tenantId } : {}),
    // #2717 M3: FIXED provenance + frozen component rows for THIS bill; {} on a plain line.
    ...invoiceCompositionFields(li, billQty, prior, subtotal, tenantId),
  };
}
