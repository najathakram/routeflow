/**
 * SA-124h round-4 prefactor: the per-item price/data build for updateOrderItems' replaceAll
 * rebuild (master's original logic, reverted byte-for-byte by SA-124g/h's R1 — see
 * ./replace-all-pack-resolution.ts's header), moved out of orders.service.ts verbatim to
 * keep the size ratchet's ceiling after merging origin/master's own unrelated growth
 * (operator tier-price columns). A pure code relocation — every decision, comment and
 * ordering is unchanged; only the closures over updateOrderItems' local state became an
 * explicit `ReplaceAllLineBuildCtx` parameter, and the trailing `tx.orderItem.create` call
 * became a `return` of the same `data` object (minus `orderId`/`position`, which the caller
 * — the only call site, in updateOrderItems — still supplies itself). Returns `null` exactly
 * where the original `continue`d (a normalized qty <= 0).
 */
import { BadRequestException } from "@nestjs/common";
import {
  categoryTaxSnapshotOf,
  computeLineSubtotal,
  normalizeBoxesPieces,
  type PromotionRule,
  type TrackedCategoryRow,
} from "@routeflow/pricing";
import { PriceType } from "@prisma/client";
import { isSpecialTier, rescaleBogoFreeUnits, resolveBuyerLinePrice } from "./buyer-merge-pricing";
import type { UpdateOrderItemsDto } from "./dto/update-order-items.dto";

export interface ReplaceAllLineBuildCtx {
  bogoCounterparts: Map<
    string,
    {
      qty: number;
      boxes: number | null;
      unitPrice: number;
      priceType: PriceType;
      originalPrice: number | null;
      overrideReason: string | null;
      overriddenBy: string | null;
      promoFreeUnits: number;
    }
  >;
  bogoPromos: PromotionRule[];
  existingLineByProduct: Map<string, { unitPrice: number; overrideReason: string | null }>;
  isStaffEdit: boolean;
  operatorCpMap: Map<string, number | null>;
  operatorDefaultTier: number;
  isCreateMerge?: boolean;
  buyerPromos: PromotionRule[];
  userId?: string | null;
  operatorReplaceCategoryMap: Map<string, TrackedCategoryRow>;
}

/**
 * `item` is a payload entry that already resolved to a catalog `product` and is not
 * unit-aware (the caller's own two earlier branches handle the ad-hoc and unit-aware
 * shapes before ever reaching here) — `item.productId` is therefore always set.
 */
export function buildReplaceAllLineData(
  ctx: ReplaceAllLineBuildCtx,
  item: UpdateOrderItemsDto["items"][number],
  product: any,
): Record<string, unknown> | null {
  // Recompute qty from boxes/pieces when the operator split a boxed
  // product (matches createOrder's authority). Normalize to integers and
  // roll loose pieces >= unitsPerBox into boxes. Falls back to plain qty.
  // A zero boxes+pieces payload is "not using box entry", not "zero
  // quantity" (see create()) — a POSITIVE check keeps it from zeroing a
  // real qty, and boxes/pieces stay null (box-unaware) instead of 0.
  const productId = item.productId as string;

  let qty = item.qty ?? 0;
  let boxes: number | null = null;
  let pieces: number | null = null;
  if ((item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0) {
    const split = normalizeBoxesPieces({
      boxes: item.boxes,
      pieces: item.pieces,
      qty,
      unitsPerBox: product.unitsPerBox,
    });
    qty = split.qty;
    boxes = split.boxes;
    pieces = split.pieces;
  }
  if (qty <= 0) return null;

  const catalogPrice = Number(product.pricePerUnit);
  const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
  // B60 (REG-B60): a client price that is ABSENT or merely ECHOES this
  // line's pre-edit BOGO snapshot price (tolerance 0.005 — float/decimal
  // round-trip, not an override decision) is not a repricing decision —
  // land where a qty edit of the same line lands (:3529-3675 is the
  // semantic oracle), never a bare re-create at full price.
  const bogoCounterpart = ctx.bogoCounterparts.get(productId);
  const bogoPriceUnchanged =
    bogoCounterpart != null &&
    (overridePrice === null || Math.abs(overridePrice - bogoCounterpart.unitPrice) <= 0.005);
  // Not a repricing decision ⇒ the line's override attribution survives
  // the re-create, exactly as the qty-edit oracle leaves it untouched.
  const preservedOverride = bogoPriceUnchanged ? bogoCounterpart : null;
  // B465 fix round 3 (Opus BLOCK item 2, HIGH): the same guard as the
  // diff-add/diff-update branches — a bare PRICE CHANGE on a
  // SPECIAL-tier line needs a documented reason, or the request is
  // refused before any mutation. Scoped to an ACTUAL change: skip
  // entirely when the price isn't moving relative either to the BOGO
  // snapshot (bogoPriceUnchanged) or to the general unambiguous
  // existing line for this product (replaceAllExisting) — an echoed
  // MANUAL line saved earlier with no reason, or ANY untouched line,
  // must round-trip unchanged, never retroactively demand a reason
  // for a price nobody is repricing. `foldMergeItems` (the staff
  // auto-merge's own caller) carries a surviving MANUAL override's
  // reason forward as `item.overrideReason`; when the payload omits
  // one anyway, fall back to the existing line's own stored reason
  // before refusing (mirrors the UPDATE branch's same fallback).
  const replaceAllExisting = ctx.existingLineByProduct.get(productId);
  const replaceAllPriceUnchanged =
    replaceAllExisting != null &&
    (overridePrice === null || Math.abs(overridePrice - replaceAllExisting.unitPrice) <= 0.005);
  const replaceAllTierForProduct = ctx.isStaffEdit
    ? (ctx.operatorCpMap.get(productId) ?? ctx.operatorDefaultTier)
    : 1;
  const replaceAllIsSpecialTier = isSpecialTier(replaceAllTierForProduct);
  const replaceAllHasOverrideReason = !!(
    (item.overrideReason && item.overrideReason.trim()) ||
    (replaceAllExisting?.overrideReason && replaceAllExisting.overrideReason.trim())
  );
  // B465 fix round 4 (Opus BLOCK item 1, HIGH), comment fixed round 5
  // (NIT): `replaceAllExisting == null` is null both for a line
  // genuinely NEW to the order and for an AMBIGUOUS pre-edit/incoming
  // pairing (0 or 2+ lines of that product — the same "no sound
  // mapping" shape bogoCounterparts/existingLineByProduct both refuse
  // above). Skipping the reason check for either shape here is safe:
  // this is the STAFF CREATE PATH's own auto-merge (gated on the
  // explicit isCreateMerge flag from the ONE call site that means it),
  // and `foldMergeItems` only ever forwards a stored price for an
  // EXISTING line whose priceType is MANUAL (R0's own contract) — an
  // ambiguous pairing here never carries a SPECIAL/derived price
  // forward to under-check, only ever a brand-new or MANUAL one, both
  // of which this PR's create path already leaves unchecked. Never
  // inferred from replaceAllExisting being null alone: an operator's
  // own replaceAll:true edit of an EXISTING order (isCreateMerge
  // unset) still needs the guard for a brand-new OR ambiguous line.
  const skipAsCreateMergeNewLine = !!ctx.isCreateMerge && replaceAllExisting == null;
  if (
    !bogoPriceUnchanged &&
    !replaceAllPriceUnchanged &&
    !skipAsCreateMergeNewLine &&
    overridePrice !== null &&
    replaceAllIsSpecialTier &&
    !replaceAllHasOverrideReason
  ) {
    throw new BadRequestException(
      `A reason is required to change ${product.name ?? "this"} — it's this customer's special price`,
    );
  }
  // An explicit price DIFFERENT from catalog is a genuine operator override
  // (MANUAL); one that EQUALS catalog is still an operator-typed price and is
  // stored verbatim as STANDARD/list — unchanged behavior, and the only way to
  // sell a tiered customer at list for one order. WP1: ONLY a line carrying no
  // price at all falls through to the tier ladder, and only for staff. A price
  // the BOGO branch above already treated as unchanged is never a MANUAL
  // override either, even if it differs from today's catalog list price.
  const isManualOverride =
    !bogoPriceUnchanged && overridePrice !== null && overridePrice !== catalogPrice;
  const upb = Number(product.unitsPerBox ?? 0);
  // B661-sweep: box-unaware multiply, converts to regulatedUnitBasis in a follow-up PR.
  const qtyPieces = boxes != null ? qty : upb > 1 ? qty * upb : qty;
  const qtyUnits = boxes != null ? boxes : qty;
  const priced: {
    unitPrice: number;
    originalPrice: number | null;
    priceType: PriceType;
    freeUnits: number;
  } = bogoPriceUnchanged
    ? {
        unitPrice: bogoCounterpart.unitPrice,
        // The stored strikethrough base, NOT null — a SPECIAL counterpart
        // carries the list price here and dropping it erases the "was $x"
        // from the order page, the invoice and every savings report.
        originalPrice: bogoCounterpart.originalPrice,
        priceType: bogoCounterpart.priceType,
        // Copies the stored-price qty-edit branch's rescale shape
        // verbatim (:3615-3632 is the oracle) — same promos context,
        // same product row, oldUnits/newUnits in whole selling units.
        freeUnits: rescaleBogoFreeUnits({
          promos: ctx.bogoPromos,
          productId: productId,
          category: product.category ?? null,
          unitPrice: bogoCounterpart.unitPrice,
          storedFreeUnits: bogoCounterpart.promoFreeUnits,
          oldUnits: bogoCounterpart.boxes != null ? bogoCounterpart.boxes : bogoCounterpart.qty,
          newUnits: boxes != null ? boxes : qty,
        }),
      }
    : overridePrice !== null
      ? {
          unitPrice: overridePrice,
          originalPrice: isManualOverride ? catalogPrice : null,
          priceType: isManualOverride ? PriceType.MANUAL : PriceType.STANDARD,
          freeUnits: 0,
        }
      : ctx.isStaffEdit
        ? resolveBuyerLinePrice(
            product,
            ctx.operatorCpMap.get(productId) ?? ctx.operatorDefaultTier,
            ctx.buyerPromos,
            qtyPieces,
            qtyUnits,
            null,
            // REG-B109: the exact denomination this line bills with below.
            { boxes, pieces, unitsPerBox: upb },
          )
        : {
            // Non-staff caller: legacy list pricing, no tier resolution.
            unitPrice: catalogPrice,
            originalPrice: null as number | null,
            priceType: PriceType.STANDARD,
            freeUnits: 0,
          };
  const unitPrice = priced.unitPrice;
  const subtotal = computeLineSubtotal({
    unitPrice,
    qty,
    boxes,
    pieces,
    unitsPerBox: product.unitsPerBox,
    freeUnits: priced.freeUnits,
  });
  return {
    productId: productId,
    qty,
    boxes,
    pieces,
    // Snapshot the sale-time box size on box-split lines (see create()).
    unitsPerBox:
      boxes != null && Number(product.unitsPerBox ?? 0) > 1 ? Number(product.unitsPerBox) : null,
    unitPrice,
    subtotal,
    status: "PENDING",
    notes: item.notes,
    priceType: priced.priceType,
    originalPrice: priced.originalPrice,
    // BUY_N_GET_M sale-time snapshot; null for every other line.
    promoFreeUnits: priced.freeUnits > 0 ? priced.freeUnits : null,
    // B60: on the preservation arm the attribution of WHO authorized
    // this price is carried over, not erased by a no-op save.
    // B465 fix round 3 (Opus BLOCK item 3): a blank incoming reason on
    // a genuine override falls back to the existing line's own stored
    // reason (the same unambiguous-pairing lookup the reason-required
    // guard above uses) rather than clearing it — mirrors the diff/
    // incremental UPDATE branch's identical fix.
    overrideReason: isManualOverride
      ? item.overrideReason?.trim()
        ? item.overrideReason
        : (replaceAllExisting?.overrideReason ?? null)
      : (preservedOverride?.overrideReason ?? null),
    overriddenBy: isManualOverride
      ? (ctx.userId ?? null)
      : (preservedOverride?.overriddenBy ?? null),
    // Snapshot the regulated category (spec §7).
    trackedCategoryId: product.trackedCategoryId ?? null,
    // RF-3: reporting-only subcategory snapshot (mirrors trackedCategoryId).
    trackedSubcategoryId: product.trackedSubcategoryId ?? null,
    // B297 (SA-098a): stamp the trio from the live category — a re-created
    // line on a staff replaceAll is a new sale, never a deferred placeholder.
    ...categoryTaxSnapshotOf(
      product.trackedCategoryId
        ? (ctx.operatorReplaceCategoryMap.get(product.trackedCategoryId) ?? null)
        : null,
    ),
  };
}
