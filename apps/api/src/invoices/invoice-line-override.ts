import { BadRequestException } from "@nestjs/common";
import {
  InvalidTierError,
  UnknownUnitError,
  decideStaffOverride,
  isSpecialTier,
  resolveUnitPrice,
  roundMoney,
  withinStaffOverrideTolerance,
  type LadderProduct,
  type LadderUnit,
} from "@routeflow/pricing";
import { assertSafeTextCell } from "../common/safe-text-cell";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { decideTierOverride, specialPriceReasonRequired } from "../orders/staff-override";
import { norm } from "../orders/unit-label-norm";
import type { CreateInvoiceDto } from "./dto/create-invoice.dto";
import type { ManualLineItem } from "./manual-invoice-lines";

/**
 * H3b — a typed price on a manual-invoice line (POST /invoices create, PATCH /invoices/:id edit) is judged
 * by THE staff-override rule (`decideStaffOverride`, @routeflow/pricing — the rule POST /orders/sell runs)
 * against the customer's TIER price, never the list price, so the same typed input stores the same
 * `priceType`, `originalPrice`, `overrideReason` and `overriddenBy` on either path:
 *   - within half a cent of the tier price is no override: SPECIAL (original = list) on a special tier,
 *     STANDARD otherwise, the clean tier price stored, no reason, no stamp;
 *   - a real change on a special tier with no reason is refused with the order path's own 400
 *     (`specialPriceReasonRequired`);
 *   - an override below list is DISCOUNTED, at or above list MANUAL; both keep the list price as
 *     `originalPrice` and carry the trimmed reason and the acting user.
 * The tier price of a PACK line is the product's tier pack price (`decideTierOverride`, the helper the order
 * create() calls); of a UNIT line the ladder's unit price at the tier (`resolveUnitPrice`, the call the order
 * unit builder makes). Opt-in: only the HTTP create/edit pass a ctx; estimate conversion and recurring
 * invoices carry an already-agreed price and never reach this file.
 */

export type ManualInvoiceDto = Omit<CreateInvoiceDto, "items"> & { items: ManualLineItem[] };

export type LinePriceType = "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";

/** The four price columns a decided line writes (the stamp is null unless the price is a real override). */
export interface LinePriceStamp {
  priceType: LinePriceType;
  originalPrice: number | null;
  overrideReason: string | null;
  overriddenBy: string | null;
}

export interface LineOverrideCtx {
  /** The acting staff user, written as `overriddenBy` on a real override. */
  actorId: string;
  /** The customer's tier for a product: its CustomerPrice tier, else the customer's default tier. */
  tierOf: (productId: string) => number;
  /** The server ladder (ProductUnit rows) of the products a line sells by a unit. */
  ladders: ReadonlyMap<string, readonly LadderUnit[]>;
}

/** The product columns the decision reads. */
export interface PricedProduct {
  id?: string;
  name?: string | null;
  unit?: string | null;
  unitsPerBox?: number | null;
  pricePerUnit?: unknown;
  priceTier2?: unknown;
  priceTier3?: unknown;
  priceTier4?: unknown;
  priceTier5?: unknown;
}

/** The stored line an edit re-writes (same product, same unit): a re-sent price on it is not a new override. */
export interface HeldLine {
  id?: string;
  unitLabel?: string | null;
  unitPrice?: unknown;
  priceType?: unknown;
  originalPrice?: unknown;
  overrideReason?: string | null;
  overriddenBy?: string | null;
}

export interface PricedLine {
  /** The price to write (clean tier price within half a cent of it; the typed price rounded to cents otherwise). */
  unitPrice: number;
  stamp: LinePriceStamp;
}

const str = (v: unknown): string | null => (v == null ? null : String(v));
const ladderProduct = (p: PricedProduct): LadderProduct => ({
  unit: p.unit,
  unitsPerBox: p.unitsPerBox,
  pricePerUnit: String(p.pricePerUnit ?? 0),
  priceTier2: str(p.priceTier2),
  priceTier3: str(p.priceTier3),
  priceTier4: str(p.priceTier4),
  priceTier5: str(p.priceTier5),
});

/**
 * The customer's tier resolver for a create/edit, or undefined when the caller is internal (no actor).
 * Two reads: the customer's default tier and its per-product CustomerPrice tiers (a null tier = msrp-only row).
 */
export async function loadOverride(
  prisma: { forTenant(): any },
  {
    customerId,
    items,
  }: { customerId: string; items: ReadonlyArray<{ productId?: string | null }> },
  ladders: ReadonlyMap<string, readonly LadderUnit[]>,
  actorId: string | undefined,
): Promise<LineOverrideCtx | undefined> {
  if (!actorId) return undefined;
  const db = prisma.forTenant();
  const ids = [...new Set(items.flatMap((i) => (i.productId ? [i.productId] : [])))];
  const customer = await db.customer.findFirst({
    where: { id: customerId },
    select: { pricingTier: true },
  });
  const rows: Array<{ productId: string; pricingTier: number | null }> = ids.length
    ? await db.customerPrice.findMany({ where: { customerId, productId: { in: ids } } })
    : [];
  const perProduct = new Map(rows.map((r) => [r.productId, r.pricingTier]));
  const dflt = customer?.pricingTier ?? 1;
  return { actorId, ladders, tierOf: (pid) => perProduct.get(pid) ?? dflt };
}

/**
 * The price and stamp for ONE line. `unitLabel` is the line's resolved selling unit (null = the pack). `held` is
 * the stored line an edit re-writes: its price re-sent (within half a cent) keeps ITS price, type, original
 * price, reason and author with no reason needed; a changed price is decided afresh, with the reason sent.
 * Pure: no reads (the caller resolved the tier and the ladder).
 */
export function priceInvoiceLine(args: {
  ctx: LineOverrideCtx;
  item: { unitPrice: number; overrideReason?: string | null };
  product: PricedProduct;
  unitLabel: string | null;
  held?: HeldLine | null;
}): PricedLine {
  const { ctx, item, product, unitLabel } = args;
  const held =
    args.held && norm(args.held.unitLabel ?? "") === norm(unitLabel ?? "") ? args.held : null;
  const typed = Number(item.unitPrice);
  if (held && withinStaffOverrideTolerance(typed, Number(held.unitPrice))) {
    return {
      unitPrice: roundMoney(Number(held.unitPrice)),
      stamp: {
        priceType: (str(held.priceType) ?? "STANDARD") as LinePriceType,
        originalPrice: held.originalPrice == null ? null : Number(held.originalPrice),
        overrideReason: held.overrideReason ?? null,
        overriddenBy: held.overriddenBy ?? null,
      },
    };
  }
  const reason = item.overrideReason?.trim() || null;
  if (item.overrideReason != null) {
    assertSafeTextCell(
      { overrideReason: item.overrideReason },
      { overrideReason: held?.overrideReason },
    );
  }
  const tier = ctx.tierOf(String(product.id));
  const decision =
    unitLabel == null
      ? decideTierOverride({ ...product, pricePerUnit: product.pricePerUnit }, tier, typed, reason)
      : decideUnit(ctx, product, unitLabel, tier, typed, reason);
  const overridden = decision.priceType === "DISCOUNTED" || decision.priceType === "MANUAL";
  return {
    unitPrice: decision.unitPrice,
    stamp: {
      priceType: decision.priceType,
      originalPrice: decision.originalPrice,
      overrideReason: overridden ? reason : null,
      overriddenBy: overridden ? ctx.actorId : null,
    },
  };
}

/** A unit line: the ladder's tier-1 (list) and tier unit prices, then the one rule. */
function decideUnit(
  ctx: LineOverrideCtx,
  product: PricedProduct,
  label: string,
  tier: number,
  typed: number,
  reason: string | null,
) {
  const lp = ladderProduct(product);
  const units = ctx.ladders.get(String(product.id)) ?? [];
  let listPrice: number;
  let tierPrice: number;
  try {
    listPrice = resolveUnitPrice(lp, units, label, 1);
    tierPrice = resolveUnitPrice(lp, units, label, tier);
  } catch (e) {
    if (e instanceof InvalidTierError) {
      throw new BadRequestException(
        "This customer's pricing tier is invalid (must be 1-5) — fix it on the customer first.",
      );
    }
    if (e instanceof UnknownUnitError) {
      throw new BadRequestException({
        code: API_ERROR_CODES.UNIT_NOT_OFFERED,
        message: `The ${e.unitLabel} is no longer offered for this product — choose another unit, or ask an admin to add it back.`,
      });
    }
    throw e;
  }
  const d = decideStaffOverride({
    overridePrice: typed,
    baselinePrice: tierPrice,
    listPrice,
    isSpecialTier: isSpecialTier(tier),
    hasReason: reason != null,
  });
  if ("refused" in d) throw specialPriceReasonRequired(product.name);
  return d;
}

/**
 * One line, priced: `item` carrying the decided price, and the four price columns to spread onto the built
 * line. Nothing is decided (the item is returned as sent, no stamp) without a ctx, for a line with no catalog
 * product (an unlisted charge), or when the product is unknown.
 */
export function priceLineItem<T extends { productId?: string | null; unitPrice: number }>(
  ctx: LineOverrideCtx | undefined,
  item: T & { overrideReason?: string | null },
  product: PricedProduct | undefined,
  unitLabel: string | null,
  held?: HeldLine | null,
): { item: T; stamp: Partial<LinePriceStamp> } {
  if (!ctx || !item.productId || !product) return { item, stamp: {} };
  const priced = priceInvoiceLine({
    ctx,
    item,
    product: { ...product, id: item.productId },
    unitLabel,
    held,
  });
  return { item: { ...item, unitPrice: priced.unitPrice }, stamp: priced.stamp };
}
