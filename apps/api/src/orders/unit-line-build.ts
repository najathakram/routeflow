import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import {
  isSpecialTier,
  decideStaffOverride,
  withinStaffOverrideTolerance,
  AmbiguousLineError,
  InvalidTierError,
  UnknownUnitError,
  buildLine,
  categoryTaxSnapshotOf,
  computeCategoryTax,
  computeLineSubtotalStrict,
  normalizeBoxesPieces,
  resolveLadderLevel,
  resolveUnitPrice,
  type CategoryTaxSnapshot,
  type CategoryTaxType,
  type LadderProduct,
  type LadderUnit,
  type TrackedCategoryRow,
  roundMoney,
} from "@routeflow/pricing";
import { assertUnitLineSplit } from "./unit-line-split";
import {
  asLadderProduct,
  lineUnitsPerBoxSnapshot,
  normalizeDerivedBaseLine,
  type ResolvedLineUnits,
} from "../products/line-units";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { specialPriceReasonRequired } from "./staff-override";
import { norm } from "./unit-label-norm";

/**
 * units_v1, step 4b-2 — building ONE order line that is sold by a non-pack unit (a Case, a Pallet,
 * a Piece off a boxed pack). Pure (no DB, no Nest): `OrdersService.create()` resolves the unit with
 * `resolveLineUnits` (the ONE place a factor is decided), then hands the product, the ladder and
 * the request line here. The rules, all decided by the server and never by the client:
 *   - CONTRACT: only a unit-aware resolution (`isUnitAware`) is built here. The pack's own label
 *     ("Box") and a "Piece" on a product with no pack size resolve to the PACK (`unitLabel` null) —
 *     the caller keeps those on its existing pack branch, never here.
 *   - `qty` is a COUNT OF THE UNIT (3 = three Cases). `boxes`/`pieces` are refused: they are
 *     denominated in the pack, so accepting them beside a `unitLabel` would be two conflicting axes.
 *   - stored like a box-split line whose "box" is the unit: `boxes = count`, `pieces = 0`,
 *     `qty = count x factor` (base pieces — what stock, delivery and the invoice copy already read),
 *     `unitsPerBox = factor` (the snapshot a later rewrite keeps), `unitPrice` = price PER UNIT.
 *     A factor-1 unit (a Piece off a boxed pack) is a plain per-piece line that still snapshots 1.
 *   - price mirrors the pack branch (H3): a staff-typed price is decided by THE staff-override rule
 *     (`decideStaffOverride`, @routeflow/pricing) against the customer's TIER unit price — within
 *     half a cent of it is no override (the ladder price at the customer's tier: STANDARD at tier 1,
 *     SPECIAL with original = tier-1 price otherwise); a real change on a special tier needs a
 *     reason (400 otherwise); an override BELOW the tier-1 unit price is DISCOUNTED, at or ABOVE it a
 *     MANUAL upsell (both keep the tier-1 unit price as `originalPrice`) and carries
 *     `overrideReason` + `overriddenBy`. Promotions and a customer's remembered upsell price are
 *     keyed by pack pricing and apply to pack lines only (v1 ruling).
 */

export interface UnitLineRequest {
  productId: string;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  /** Staff-typed one-time price per unit (already gated to staff by the caller). */
  unitPrice?: number | null;
  unitLabel?: string | null;
  notes?: string | null;
  itemNote?: string | null;
  /** Why a special-tier customer's price was changed (H3); required by the override rule there. */
  overrideReason?: string | null;
}

/**
 * The line an edit re-writes, as stored (H3). Only a same-product, same-unit counterpart is passed (matched
 * by line id, or by the replace-all pairing); a new or substitute line passes none.
 */
export interface StoredUnitLine {
  unitLabel?: string | null;
  unitPrice: unknown;
  priceType: string;
  originalPrice?: unknown;
  overrideReason?: string | null;
  overriddenBy?: string | null;
}

/** The `orderItem` columns a {@link StoredUnitLine} reads: the edit's locked line read selects these. */
export const STORED_UNIT_LINE_SELECT = {
  unitLabel: true,
  unitPrice: true,
  priceType: true,
  originalPrice: true,
  overrideReason: true,
  overriddenBy: true,
} as const;

/**
 * An EXISTING line's own snapshot (units P0b). When its `unitLabel` no longer names a level of the
 * live ladder, a rewrite re-resolves from this — factor = `unitsPerBox`, price = `unitPrice` — and
 * never throws `UnknownUnitError`. A NEW line has none, and still gets the 400.
 */
export interface UnitSnapshotLine {
  unitLabel?: string | null;
  unitsPerBox?: number | null;
  unitPrice?: unknown;
  originalPrice?: unknown;
  priceType?: PriceType | null;
  /** The override stamp the line carries (a DISCOUNTED / MANUAL line), copied when the unit is gone. */
  overrideReason?: string | null;
  overriddenBy?: string | null;
}

/** A Prisma `Decimal` (or number/string) — coerced once by `toLadderProduct`. */
type Money = number | string | { toString(): string };

/** The subset of `Product` a unit line reads (tracked-category snapshots + the ladder base). */
export interface UnitLineProduct {
  /** Names the product in the "reason required" 400. */
  name?: string | null;
  unit?: string | null;
  unitsPerBox?: number | null;
  pricePerUnit: Money;
  priceTier2?: Money | null;
  priceTier3?: Money | null;
  priceTier4?: Money | null;
  priceTier5?: Money | null;
  trackedCategoryId?: string | null;
  trackedSubcategoryId?: string | null;
}

const str = (v: Money | null | undefined): string | null => (v == null ? null : String(v));
const toLadderProduct = (p: UnitLineProduct): LadderProduct => ({
  unit: p.unit,
  unitsPerBox: p.unitsPerBox,
  pricePerUnit: String(p.pricePerUnit),
  priceTier2: str(p.priceTier2),
  priceTier3: str(p.priceTier3),
  priceTier4: str(p.priceTier4),
  priceTier5: str(p.priceTier5),
});

/** true when the request asks to sell by a named unit (`""`/null/undefined = the pack). */
export const requestsUnit = (item: { unitLabel?: string | null } | null | undefined): boolean =>
  (item?.unitLabel ?? "").trim() !== "";

/** true when `resolveLineUnits` decided this line is NOT the pack — the only lines built here. */
export const isUnitAware = (resolved: ResolvedLineUnits): boolean => resolved.unitLabel != null;

/**
 * Who may sell by a unit, and only under `flag.units_v1`. Nothing is consulted when no line asks
 * for a unit, so a tenant without the flag pays nothing and a pack-only request is byte-identical.
 * Buyers are refused: the buyer portal stays on the product's default unit (owner ruling). A custom
 * (unlisted) line has no ladder, so a unit on one is refused rather than silently dropped.
 */
export async function assertMayUseUnits(
  items: ReadonlyArray<{
    unitLabel?: string | null;
    productId?: string | null;
    id?: string | null;
  }>,
  ctx: {
    isStaff: boolean;
    tenantId: string | null | undefined;
    hasFlag: (tenantId: string, flag: string) => Promise<boolean>;
  },
): Promise<void> {
  if (!items.some(requestsUnit)) return;
  if (!ctx.isStaff) {
    throw new BadRequestException("Only staff can choose a selling unit on an order line.");
  }
  // An `id`-only edit of an EXISTING line (updateOrderItems, A1) carries no productId of its
  // own — that never means "custom/unlisted" the way it does on a fresh create() line.
  if (items.some((i) => requestsUnit(i) && !i.productId && !i.id)) {
    throw new BadRequestException("A custom line has no selling units — pick a catalog product.");
  }
  if (!ctx.tenantId || !(await ctx.hasFlag(ctx.tenantId, "flag.units_v1"))) {
    throw new ForbiddenException("Selling by unit is not included in this plan.");
  }
}

/**
 * The server ladder (ProductUnit rows) of the given products, grouped by product. `db` is the
 * TENANT-SCOPED client (`prisma.forTenant()`), so a foreign product id can never read another
 * tenant's levels. No ids = no query.
 */
export async function loadUnitLadders(
  db: { productUnit: { findMany(args: any): Promise<any[]> } },
  productIds: ReadonlyArray<string>,
): Promise<Map<string, LadderUnit[]>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  const out = new Map<string, LadderUnit[]>();
  if (ids.length === 0) return out;
  const rows = await db.productUnit.findMany({
    where: { productId: { in: ids } },
    orderBy: { sortOrder: "asc" },
  });
  for (const r of rows) {
    const list = out.get(r.productId) ?? [];
    list.push(r as LadderUnit);
    out.set(r.productId, list);
  }
  return out;
}

/**
 * `OrdersService.create()` in ONE call: the gate (who may sell by a unit, under flag.units_v1) and
 * the server ladder of every product a line names a unit for. Reads nothing when no line asks.
 */
export async function prepareUnitLadders(
  items: ReadonlyArray<{ unitLabel?: string | null; productId?: string | null }>,
  ctx: {
    isStaff: boolean;
    prisma: { getTenantId(): string | null | undefined; forTenant(): any };
    entitlements: { hasFlag(tenantId: string, flag: string): Promise<boolean> };
  },
): Promise<Map<string, LadderUnit[]>> {
  await assertMayUseUnits(items, {
    isStaff: ctx.isStaff,
    tenantId: ctx.prisma.getTenantId(),
    hasFlag: (t, f) => ctx.entitlements.hasFlag(t, f),
  });
  return loadUnitLadders(
    ctx.prisma.forTenant(),
    items.filter(requestsUnit).map((i) => i.productId as string),
  );
}

/**
 * One line's identity in the Idempotency-Key replay comparison. A unit line's REQUEST qty counts the
 * unit (3 = three Cases) while the STORED qty is base pieces, so a stored unit line compares by its
 * unit count (`boxes ?? qty`) and carries its label; a pack line's key is unchanged.
 */
export function replayLineKey(
  r: {
    productId?: string | null;
    name?: string | null;
    qty?: unknown;
    boxes?: unknown;
    pieces?: unknown;
    unitsPerBox?: unknown;
    unitLabel?: string | null;
  },
  stored: boolean,
): string {
  const unit = (r.unitLabel ?? "").trim().toLowerCase();
  let count: unknown = stored && unit ? (r.boxes ?? r.qty) : r.qty;
  // A boxes/pieces-only request line has no qty: derive the piece count the writer stores (same
  // normalizeBoxesPieces) instead of keying NaN, which can never match a stored line. Without a pack size
  // it falls back to the split itself, so the key is still well-formed (never NaN).
  if (count == null && !unit && (r.boxes != null || r.pieces != null)) {
    const upb = Number(r.unitsPerBox ?? 0);
    count =
      upb > 1
        ? normalizeBoxesPieces({
            boxes: Number(r.boxes ?? 0),
            pieces: Number(r.pieces ?? 0),
            unitsPerBox: upb,
          }).qty
        : `b${Number(r.boxes ?? 0)}p${Number(r.pieces ?? 0)}`;
    return `${r.productId ?? `unlisted:${r.name ?? ""}`}×${String(count)}`;
  }
  return `${r.productId ?? `unlisted:${r.name ?? ""}`}×${Number(count)}${unit ? `@${unit}` : ""}`;
}

/**
 * Regulated per-category tax for a unit line (0 when the product has no tracked category), PLUS
 * (B297/SA-088) the rate trio it was computed from — the ONE place `taxFor` below produces both
 * together, so a unit line's snapshot can never drift from the amount it priced.
 */
export const categoryTaxForLine = (
  category: TrackedCategoryRow | null | undefined,
  qtyPieces: number,
  lineSubtotal: number,
): { amount: number; snapshot: CategoryTaxSnapshot } => ({
  amount: category
    ? computeCategoryTax({
        taxType: category.taxType,
        rate: Number(category.rate),
        unitBasisQty: qtyPieces,
        lineSubtotal,
        priceIncludesTax: category.priceIncludesTax ?? undefined,
      })
    : 0,
  snapshot: categoryTaxSnapshotOf(
    category
      ? {
          taxType: category.taxType,
          rate: category.rate,
          priceIncludesTax: category.priceIncludesTax,
        }
      : null,
  ),
});

/** OrderItem.qty is Decimal(10,3) and subtotal Decimal(10,2): a bigger line would 500 the order. */
export const MAX_LINE_QTY = 9_999_999;
export const MAX_LINE_SUBTOTAL = 99_999_999.99;

export interface UnitLineData {
  productId: string;
  name: null;
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  unitLabel: string;
  unitPrice: number;
  priceType: PriceType;
  originalPrice: number | null;
  /** Present only on a real staff override (H3) — never written for a ladder-priced line. */
  overrideReason?: string | null;
  overriddenBy?: string;
  promoFreeUnits: null;
  subtotal: number;
  notes: string | undefined;
  trackedCategoryId: string | null;
  trackedSubcategoryId: string | null;
  categoryTaxAmount: number;
  categoryTaxType: CategoryTaxSnapshot["categoryTaxType"];
  categoryTaxRate: CategoryTaxSnapshot["categoryTaxRate"];
  categoryPriceIncludesTax: CategoryTaxSnapshot["categoryPriceIncludesTax"];
  position: number;
  tenantId: string | null | undefined;
}

/** Does the live ladder still name `label`? (the pack, the base, or a level row) */
function ladderNames(product: LadderProduct, units: readonly LadderUnit[], label: string): boolean {
  try {
    resolveLadderLevel(product, units, label);
    return true;
  } catch (e) {
    if (e instanceof UnknownUnitError) return false;
    throw e;
  }
}

export function buildUnitLine(input: {
  product: UnitLineProduct;
  units: readonly LadderUnit[];
  resolved: ResolvedLineUnits;
  item: UnitLineRequest;
  /** The customer's pricing tier for this product (1..5). */
  tier: number;
  /**
   * Regulated per-category tax for a line of `qtyPieces` base pieces worth `subtotal`, PLUS
   * (B297) the rate trio it was priced under — see `categoryTaxForLine`. A caller that defers
   * the amount to a later recompute pass (unit-line-edit.ts's `taxFor: () => 0`) defers the
   * snapshot the same way — the two must never disagree about whether this line has been priced.
   */
  taxFor: (
    qtyPieces: number,
    subtotal: number,
  ) => { amount: number; snapshot: CategoryTaxSnapshot };
  /** Set on every line by the caller's tenancy: a nested create bypasses `forTenant()`. */
  position: number;
  tenantId: string | null | undefined;
  /** The staff user whose typed price overrides the ladder (H3); stamped only on a real override. */
  overriddenBy?: string | null;
  /**
   * H3: the stored line this one re-writes. Sending NO price, or re-sending the price ALREADY on it, is not a new override: the
   * line keeps its stored price, type, original price, reason and stamp, no reason needed (an internal
   * re-write must never 400 on a stored override). A CHANGED price is re-decided against the tier price
   * and needs a reason sent with it (a 400 otherwise).
   */
  stored?: StoredUnitLine | null;
  /**
   * H3: on a qty-only edit (no price sent) re-price a stored TIER line at the customer's current tier instead of
   * keeping its stored price: the buyer's count diff (SA-507b). Staff edits leave it off and keep, like the pack
   * branch. An override is kept either way.
   */
  repriceTierOnQtyOnly?: boolean;
  /** The line being rewritten, when one exists (see {@link UnitSnapshotLine}). */
  existing?: UnitSnapshotLine | null;
}): UnitLineData {
  const { product, units, resolved, item, tier, taxFor } = input;
  const ladderProduct = toLadderProduct(product);
  const label = resolved.unitLabel;
  if (label == null) throw new Error("buildUnitLine needs a unit-aware resolution, not the pack");
  if ((item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0) {
    throw new BadRequestException(
      `A line sold by the ${label} takes a quantity of ${label} units only — leave boxes and pieces out.`,
    );
  }
  // B682/SA-145: the count/split validation is buildLine's unit axis (site 2 of 2 —
  // buildInvoiceItemData is excluded, it prorates a stored subtotal). This call's own
  // `subtotal` is discarded (unitPrice isn't known yet — tier pricing below resolves it);
  // it exists only to get buildLine's validated `{boxes, pieces, qty}` split and reject a
  // fractional/non-positive count with the SAME wording every buildLine site uses, rather
  // than the old `Math.trunc`, which used to silently bill 1 for a typed 1.5 on the EDIT
  // path (CREATE's own DTO is already `@IsInt`, so it never reached here truncated).
  const factor = resolved.unitsPerBox;
  let split: { boxes: number | null; pieces: number | null; qty: number };
  try {
    split = buildLine({
      axis: { kind: "unit", label, count: Number(item.qty), factorToBase: factor },
      unitPrice: 0,
    });
  } catch (e) {
    if (e instanceof AmbiguousLineError) {
      throw new BadRequestException(
        `A line sold by the ${label} needs a whole number of ${label}.`,
      );
    }
    throw e;
  }
  if (split.qty > MAX_LINE_QTY) {
    throw new BadRequestException(
      `${item.qty} x ${label} is ${split.qty.toLocaleString("en-US")} pieces — over the ${MAX_LINE_QTY.toLocaleString("en-US")} a single line can hold.`,
    );
  }

  // Units P0b: a rewrite of a line HELD on a unit the ladder no longer names keeps its own snapshot.
  const snap = input.existing;
  const gone =
    snap != null &&
    (snap.unitLabel ?? "").trim().toLowerCase() === label.trim().toLowerCase() &&
    Number(snap.unitPrice) >= 0 &&
    !ladderNames(ladderProduct, units, label);
  let listPrice: number;
  let tierPrice: number;
  try {
    if (gone) {
      tierPrice = roundMoney(Number(snap.unitPrice));
      listPrice = roundMoney(Number(snap.originalPrice ?? snap.unitPrice));
    } else {
      listPrice = resolveUnitPrice(ladderProduct, units, label, 1);
      tierPrice = resolveUnitPrice(ladderProduct, units, label, tier);
    }
  } catch (e) {
    if (e instanceof InvalidTierError) {
      throw new BadRequestException(
        "This customer's pricing tier is invalid (must be 1-5) — fix it on the customer first.",
      );
    }
    // #2277: a line HELD in a unit the product no longer offers (removed after the order was
    // placed) keeps its snapshot factor through resolveLineUnits, but has no ladder price — a 400
    // with a remedy, never an UnknownUnitError escaping as a 500.
    if (e instanceof UnknownUnitError) {
      throw new BadRequestException({
        code: API_ERROR_CODES.UNIT_NOT_OFFERED,
        message: `The ${e.unitLabel} is no longer offered for this product — choose another unit, or ask an admin to add it back.`,
      });
    }
    throw e;
  }
  // H3: ONE rule for a staff-typed price — judged against the customer's TIER unit price, never the list.
  const held =
    input.stored && norm(input.stored.unitLabel ?? "") === norm(label) ? input.stored : null;
  // no price sent (a qty-only edit) or the stored price re-sent: the line keeps its stored decision, exactly as
  // the pack branch keeps `existingUnitPrice` (orders.service.ts, updateOrderItems); only a CHANGED price re-decides
  // an OVERRIDE (DISCOUNTED / MANUAL, or SPECIAL with a reason on file) is kept on every path; a plain tier line is
  // kept too, except where the caller re-prices tier lines on a qty-only edit (the buyer's count diff, SA-507b)
  const heldIsOverride =
    held != null &&
    (held.priceType === PriceType.DISCOUNTED ||
      held.priceType === PriceType.MANUAL ||
      (held.priceType === PriceType.SPECIAL && !!held.overrideReason?.trim()));
  const echoesHeld =
    held != null &&
    (item.unitPrice == null
      ? !input.repriceTierOnQtyOnly || heldIsOverride
      : withinStaffOverrideTolerance(Number(item.unitPrice), Number(held.unitPrice)));
  const decision =
    item.unitPrice != null && !echoesHeld
      ? decideStaffOverride({
          overridePrice: Number(item.unitPrice),
          baselinePrice: tierPrice,
          listPrice,
          isSpecialTier: isSpecialTier(tier),
          hasReason: !!item.overrideReason?.trim(),
        })
      : null;
  if (decision && "refused" in decision) throw specialPriceReasonRequired(product.name);
  // Units P0b: a line held on a unit the ladder lost keeps how its snapshot was classified (never re-derived from the
  // ladder that lost the level); otherwise the tier decides.
  const ladderType: PriceType = gone
    ? (snap?.priceType ?? PriceType.STANDARD)
    : isSpecialTier(tier)
      ? PriceType.SPECIAL
      : PriceType.STANDARD;
  const unitPrice = echoesHeld
    ? roundMoney(Number(held.unitPrice))
    : decision
      ? decision.unitPrice
      : tierPrice;
  const priceType: PriceType = echoesHeld
    ? (held.priceType as PriceType)
    : decision
      ? PriceType[decision.priceType]
      : ladderType;
  const originalPrice: number | null = echoesHeld
    ? held.originalPrice == null
      ? null
      : Number(held.originalPrice)
    : decision
      ? decision.originalPrice
      : gone
        ? snap?.originalPrice == null
          ? null
          : roundMoney(Number(snap.originalPrice))
        : isSpecialTier(tier)
          ? listPrice
          : null;
  const overridden = priceType === PriceType.DISCOUNTED || priceType === PriceType.MANUAL;
  // the stamp: a held override keeps ITS reason and user; a new one is this edit's
  const stamp = !overridden
    ? null
    : echoesHeld
      ? {
          overrideReason: held.overrideReason ?? null,
          overriddenBy: held.overriddenBy ?? undefined,
        }
      : gone && snap && !decision
        ? // a gone unit with no typed price re-writes the snapshot: its override keeps ITS reason and user
          {
            overrideReason: snap.overrideReason ?? null,
            overriddenBy: snap.overriddenBy ?? undefined,
          }
        : input.overriddenBy
          ? {
              overrideReason: item.overrideReason?.trim() || null,
              overriddenBy: input.overriddenBy,
            }
          : null;

  // The real subtotal, now that tier pricing has resolved the actual unitPrice — the split
  // above is already buildLine-validated, so computeLineSubtotalStrict never throws here.
  const subtotal = computeLineSubtotalStrict({
    unitPrice,
    qty: split.qty,
    boxes: split.boxes,
    pieces: split.pieces,
    unitsPerBox: factor,
  });
  if (subtotal > MAX_LINE_SUBTOTAL) {
    throw new BadRequestException(
      `This line's total is over the ${MAX_LINE_SUBTOTAL} one line can hold.`,
    );
  }

  const categoryTax = taxFor(split.qty, subtotal);
  return assertUnitLineSplit(
    {
      productId: item.productId,
      name: null,
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox: lineUnitsPerBoxSnapshot(resolved, split.boxes, "boxed"),
      unitLabel: label,
      unitPrice,
      priceType,
      originalPrice,
      ...(stamp ?? {}),
      promoFreeUnits: null,
      subtotal,
      notes: item.itemNote || item.notes || undefined,
      trackedCategoryId: product.trackedCategoryId ?? null,
      trackedSubcategoryId: product.trackedSubcategoryId ?? null,
      categoryTaxAmount: categoryTax.amount,
      // B297 (SA-088): the rate trio categoryTaxAmount was computed from (or, for a caller that
      // defers the amount to a later recompute pass, deferred the same way — see `taxFor`).
      categoryTaxType: categoryTax.snapshot.categoryTaxType,
      categoryTaxRate: categoryTax.snapshot.categoryTaxRate,
      categoryPriceIncludesTax: categoryTax.snapshot.categoryPriceIncludesTax,
      position: input.position,
      tenantId: input.tenantId,
    },
    "buildUnitLine",
  );
}

/**
 * SA-728 / units P0b: `OrdersService.create()` — a derived Piece from an old client becomes the pack
 * line's pieces (see `normalizeDerivedBaseLine`); every other item comes back as the SAME object.
 */
export function derivedBaseAsPack<T extends { productId?: string | null }>(
  item: T,
  products: ReadonlyMap<string, any>,
  ladders: ReadonlyMap<string, LadderUnit[]>,
  tierOverrides: ReadonlyMap<string, number | null>,
  defaultTier: number,
): T {
  const p = item.productId ? products.get(item.productId) : undefined;
  if (!p) return item;
  return normalizeDerivedBaseLine(
    item as T & Parameters<typeof normalizeDerivedBaseLine>[0],
    asLadderProduct(p),
    ladders.get(p.id) ?? [],
    tierOverrides.get(p.id) ?? defaultTier,
  );
}
