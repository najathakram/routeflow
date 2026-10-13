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
import {
  isSpecialTier,
  categoryTaxSnapshotOf,
  computeLineSubtotal,
  getTierPrice,
  normalizeBoxesPieces,
  withinStaffOverrideTolerance,
  type PromotionRule,
  type TrackedCategoryRow,
} from "@routeflow/pricing";
import { PriceType } from "@prisma/client";
import { rescaleBogoFreeUnits, resolveBuyerLinePrice } from "./buyer-merge-pricing";
import { decideTierOverride } from "./staff-override";
import type { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { decideReplaceAllLinePrice } from "./staff-line-price";
import { carriedCategory, type CarriedCategorySource } from "./carry-line-category";

interface ExistingLineForReplaceAll {
  unitPrice: number;
  priceType: PriceType;
  originalPrice: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
  /** B297 row 340: the line's own category and rate trio, carried onto a folded re-creation of it. */
  category: CarriedCategorySource;
  /** B297 row 355: its createdAt, carried too (the free-unit allocation is oldest first by createdAt). */
  createdAt?: Date | string | null;
}

/**
 * The pre-edit snapshot of a BOGO counterpart line (any line carrying a free-unit snapshot: it
 * can be SPECIAL, DISCOUNTED or MANUAL, not only PROMO). `priceType`, its strikethrough base
 * `originalPrice` and the override attribution are copied VERBATIM: the qty-edit oracle writes
 * originalPrice / overrideReason / overriddenBy ONLY under isManualOverride, so at an unchanged
 * price they must survive the replaceAll re-create untouched. Moved out of orders.service.ts.
 */
export function buildBogoCounterpart(li: any) {
  return {
    qty: Number(li.qty),
    boxes: li.boxes ?? null,
    unitPrice: Number(li.unitPrice),
    priceType: li.priceType,
    originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
    overrideReason: li.overrideReason ?? null,
    overriddenBy: li.overriddenBy ?? null,
    promoFreeUnits: Number(li.promoFreeUnits ?? 0),
  };
}

/**
 * Both existingLine* maps updateOrderItems' replaceAll rebuild needs, built in one pass —
 * moved out of orders.service.ts (round 5) to keep the size ratchet's ceiling. `existingLineById`
 * covers every non-cancelled pre-edit line unconditionally (an id is never ambiguous);
 * `existingLineByProduct` keeps the original unambiguous-pairing gate (exactly one pre-edit AND
 * one incoming line for that product) as the fallback for a caller with no sourceLineId.
 */
export function buildExistingLineMaps(
  lineItems: Array<
    {
      id?: string | null;
      productId?: string | null;
      status?: string | null;
      createdAt?: Date | string | null;
      unitPrice: unknown;
      priceType: PriceType;
      originalPrice: unknown;
      overrideReason?: string | null;
      overriddenBy?: string | null;
    } & CarriedCategorySource
  >,
  preEditLinesByProduct: Map<string, number>,
  incomingLinesByProduct: Map<string, number>,
): {
  existingLineByProduct: Map<string, ExistingLineForReplaceAll>;
  existingLineById: Map<string, ExistingLineForReplaceAll>;
} {
  const existingLineByProduct = new Map<string, ExistingLineForReplaceAll>();
  const existingLineById = new Map<string, ExistingLineForReplaceAll>();
  for (const li of lineItems ?? []) {
    if (!li.id || li.status === "CANCELLED") continue;
    const entry: ExistingLineForReplaceAll = {
      ...(li.createdAt ? { createdAt: li.createdAt } : {}),
      unitPrice: Number(li.unitPrice),
      priceType: li.priceType,
      originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
      overrideReason: li.overrideReason ?? null,
      overriddenBy: li.overriddenBy ?? null,
      category: {
        productId: li.productId,
        trackedCategoryId: li.trackedCategoryId,
        trackedSubcategoryId: li.trackedSubcategoryId,
        categoryTaxType: li.categoryTaxType,
        categoryTaxRate: li.categoryTaxRate,
        categoryPriceIncludesTax: li.categoryPriceIncludesTax,
        categoryTaxAmount: li.categoryTaxAmount,
      },
    };
    existingLineById.set(li.id, entry);
    if (
      li.productId &&
      preEditLinesByProduct.get(li.productId) === 1 &&
      incomingLinesByProduct.get(li.productId) === 1 &&
      !existingLineByProduct.has(li.productId)
    ) {
      existingLineByProduct.set(li.productId, entry);
    }
  }
  return { existingLineByProduct, existingLineById };
}

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
  existingLineByProduct: Map<string, ExistingLineForReplaceAll>;
  // SA-124i (option i, #938): keyed by the SPECIFIC line's own id — foldMergeItems (merge-
  // items.ts) already emits `sourceLineId` on every bucket seeded from an existing line, so a
  // folded payload item can be compared against THAT exact line instead of guessed by product
  // (existingLineByProduct's own two-pack shape treats 2+ pre-edit lines of one product as
  // ambiguous and skips both). No DTO field: sourceLineId only ever travels on the internal
  // fold -> updateOrderItems call, never through the public DTO (which still rejects it).
  existingLineById: Map<string, ExistingLineForReplaceAll>;
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
    (overridePrice === null ||
      withinStaffOverrideTolerance(overridePrice, bogoCounterpart.unitPrice));
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
  // SA-124f item 1 / SA-124i (option i): a folded payload item carries `sourceLineId` when
  // foldMergeItems seeded its bucket from an existing line — not a DTO field (see the ctx
  // interface's comment), read loosely since UpdateOrderItemsDto has no such property.
  const sourceLineId = (item as { sourceLineId?: string }).sourceLineId;
  const replaceAllExisting = sourceLineId
    ? ctx.existingLineById.get(sourceLineId)
    : ctx.existingLineByProduct.get(productId);
  const replaceAllTierForProduct = ctx.isStaffEdit
    ? (ctx.operatorCpMap.get(productId) ?? ctx.operatorDefaultTier)
    : 1;
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
  // #2696(c) SA-558d (i): that NEW line IS a staff create, so it takes create's rule A
  // (decideTierOverride: tier baseline, the sent reason, the same 400; within ½¢ of tier ⇒ the
  // tier ladder below) — a fresh order and a folded one price the same payload identically.
  const createMergeDecision =
    skipAsCreateMergeNewLine && overridePrice !== null && !bogoPriceUnchanged
      ? decideTierOverride(product, replaceAllTierForProduct, overridePrice, item.overrideReason)
      : null;
  const createMergeOverride = createMergeDecision?.overridden ? createMergeDecision : null;
  // #2716c / SA-558d: ONE rule (staff-line-price.ts -> decideStaffOverride) for a typed price that
  // is not the BOGO snapshot's echo. Against a stored counterpart the baseline is its stored
  // price and an echo is preserved verbatim (never re-stamped); otherwise the tier price. A
  // special-tier change needs a reason (B465); below list is DISCOUNTED, at/above list MANUAL,
  // originalPrice = list. WP1: ONLY a line carrying no price at all falls through to the tier
  // ladder, and only for staff.
  const replaceAllDecision =
    !bogoPriceUnchanged && overridePrice !== null && !skipAsCreateMergeNewLine
      ? decideReplaceAllLinePrice({
          overridePrice,
          existing: replaceAllExisting ?? null,
          tierPrice: Number(getTierPrice(product, replaceAllTierForProduct)),
          listPrice: catalogPrice,
          isSpecialTier: isSpecialTier(replaceAllTierForProduct),
          hasReason: replaceAllHasOverrideReason,
          skipReasonGuard: skipAsCreateMergeNewLine,
          productName: product.name,
        })
      : null;
  const isManualOverride = createMergeDecision
    ? !!createMergeOverride
    : !!replaceAllDecision?.repriced;
  // An echo of the stored counterpart keeps that line's own attribution (like the BOGO arm).
  const echoedExisting =
    replaceAllDecision &&
    !replaceAllDecision.repriced &&
    !replaceAllDecision.restored &&
    replaceAllExisting
      ? replaceAllExisting
      : null;
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
    : createMergeOverride
      ? {
          unitPrice: createMergeOverride.unitPrice,
          originalPrice: createMergeOverride.originalPrice,
          priceType: PriceType[createMergeOverride.priceType],
          freeUnits: 0,
        }
      : replaceAllDecision
        ? {
            unitPrice: replaceAllDecision.unitPrice,
            originalPrice: replaceAllDecision.originalPrice,
            priceType: replaceAllDecision.priceType,
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
        ? createMergeOverride
          ? item.overrideReason.trim()
          : item.overrideReason
        : (replaceAllExisting?.overrideReason ?? null)
      : (preservedOverride?.overrideReason ?? echoedExisting?.overrideReason ?? null),
    overriddenBy: isManualOverride
      ? (ctx.userId ?? null)
      : (preservedOverride?.overriddenBy ?? echoedExisting?.overriddenBy ?? null),
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
    // B297 row 340: ...EXCEPT a folded line that comes from an existing line (`sourceLineId`), which carries
    // that line's own category and trio, never the product's current ones (a fold is not a new sale).
    ...(sourceLineId
      ? (carriedCategory(ctx.existingLineById.get(sourceLineId)?.category, productId) ?? {})
      : {}),
    // B297 row 355 (r-note 7): ...and its createdAt, or a re-created old line sorts AFTER a newer one and
    // the split's free units (allocated oldest first by createdAt) move onto the wrong line.
    ...(sourceLineId && ctx.existingLineById.get(sourceLineId)?.createdAt
      ? { createdAt: ctx.existingLineById.get(sourceLineId)!.createdAt as Date }
      : {}),
  };
}

/**
 * The per-product pairing maps of updateOrderItems' replaceAll rebuild (moved verbatim out of
 * orders.service.ts, #2717, to keep the size ratchet's ceiling): pre-edit and incoming line counts
 * per product, and the BUY_N_GET_M counterparts, built once from the PRE-edit lines.
 */
export function buildReplaceAllPairing(
  order: { lineItems?: any[] | null },
  dto: { items?: Array<{ productId?: string | null }> | null },
): {
  preEditLinesByProduct: Map<string, number>;
  incomingLinesByProduct: Map<string, number>;
  bogoCounterparts: Map<string, any>;
} {
  // B60 (REG-B60): a staff replaceAll at an unchanged/echoed price must
  // land exactly where a qty edit of the same line lands — reuse the
  // stored price + priceType and RESCALE (never drop) the line's
  // BUY_N_GET_M snapshot instead of silently re-creating it at full
  // price. Built once from the PRE-edit lines, before the delete below
  // erases them.
  //
  // ⚠️ UNAMBIGUOUS PAIRS ONLY. A replaceAll payload carries no line ids,
  // and an order may legitimately hold SEVERAL lines of one product (the
  // diff-add branch creates a new row for an id-less item even when a line
  // for that product exists). Keying a counterpart by productId alone then
  // hands the snapshot — and its override attribution — to every echoed
  // line of that product, including a sibling that never earned one: two
  // lines of prod-X (qty 10 with 2 free units, qty 5 with none) echoed by a
  // no-op save would bill the second 5.00 x (5-1) = 20.00 instead of 25.00
  // and stamp it with the first line's overrideReason/overriddenBy. The
  // qty-edit oracle this arm copies yields 0 free units for that sibling
  // (storedFreeUnits 0, canEarnNew false), and rescaleBogoFreeUnits' own
  // contract is that no operator line gains a promo it never had.
  // There is no sound N-to-N mapping to recover here, so preservation is
  // registered ONLY when the pairing is unambiguous: exactly one pre-edit
  // non-cancelled line for that product AND exactly one incoming line for
  // it. Any other shape falls through to the pre-F06 behavior (re-created
  // at the resolved price, snapshot dropped) — that shape is not fixed by
  // F06, but it is never granted a snapshot it did not earn.
  const preEditLinesByProduct = new Map<string, number>();
  for (const li of order.lineItems ?? []) {
    if (!li.productId || li.status === "CANCELLED") continue;
    preEditLinesByProduct.set(li.productId, (preEditLinesByProduct.get(li.productId) ?? 0) + 1);
  }
  const incomingLinesByProduct = new Map<string, number>();
  for (const it of dto.items ?? []) {
    if (!it.productId) continue;
    incomingLinesByProduct.set(it.productId, (incomingLinesByProduct.get(it.productId) ?? 0) + 1);
  }
  const bogoCounterparts = new Map<string, any>();
  for (const li of order.lineItems ?? []) {
    if (
      li.productId &&
      li.status !== "CANCELLED" &&
      Number((li as any).promoFreeUnits ?? 0) > 0 &&
      preEditLinesByProduct.get(li.productId) === 1 &&
      incomingLinesByProduct.get(li.productId) === 1 &&
      !bogoCounterparts.has(li.productId)
    ) {
      bogoCounterparts.set(li.productId, buildBogoCounterpart(li));
    }
  }
  return { preEditLinesByProduct, incomingLinesByProduct, bogoCounterparts };
}
