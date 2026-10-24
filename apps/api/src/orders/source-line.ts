import { BadRequestException } from "@nestjs/common";
import type { PriceType } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * D-20 (#1808, SA-304 / SA-330) — the SOURCE line's denomination for a copier that re-creates a line through
 * `OrdersService.create` (today: `approveNextDelivery`, copier C8, for a CHANGE_QTY rollover).
 *
 * `create()` splits and prices a NEW line at the LIVE product pack and the customer's CURRENT price, which is right for
 * a new sale but wrong for the copy of an existing, already-agreed line: after a repack or a price change since the
 * sale the copy would be re-split AND re-priced. A next-delivery approval is a logistics outcome, not a re-quote, so
 * the copier passes the source line's `unitsPerBox` (only when the source is box-aware; null = the live pack, as for a
 * bare selling-unit line) together with its `unitPrice`, `priceType` and `originalPrice`. Pack and price are ONE
 * denomination (the price is per BOX at that pack): carrying one without the other is a second pricing formula, so
 * neither is scaled. `create()` then feeds the carried pack into `normalizeBoxesPieces` / `computeLineSubtotal`
 * (`@routeflow/pricing`) and stores the carried price, type and original price as they were (never relabelled MANUAL
 * or DISCOUNTED). The line earns no promo units: `promoFreeUnits` is 0 for a rollover line. The subtotal stays
 * re-derived, by `computeLineSubtotal` at the carried pack and price.
 *
 * The audit trail of a carried MANUAL/DISCOUNTED price (`overrideReason`, `overriddenBy`) rides with it, so a
 * carried override never becomes an unexplained price.
 *
 * Tax: the copy stamps the LIVE category tax rate (B297 snapshot taken at the copy, a later sale), whereas an at-stop
 * line keeps its sale-time snapshot. Tax is not part of the carried denomination.
 *
 * INTERNAL ONLY: this lives on `create()`'s `options` argument (a service-to-service parameter), never on a DTO or a
 * controller path (pinned in `source-line.spec.ts`), so no HTTP caller can choose a line's pack or price. A CUSTOMER
 * pseudo-user's `item.unitPrice` stays ignored.
 *
 * Keyed by productId because `create()`'s line inputs carry no source-line id. Ambiguity is REFUSED, never resolved by
 * first match (SA-030/036): a source line for a product that appears on more than one draft line is a 400.
 */
export interface SourceLine {
  /** The source line's pack, or null when it is not box-aware (create() then uses the live pack). */
  unitsPerBox: number | null;
  unitPrice: number;
  priceType: PriceType;
  originalPrice: number | null;
  /** The audit trail of a carried MANUAL/DISCOUNTED price: why, and by whom (both null for a standard line). */
  overrideReason: string | null;
  overriddenBy: string | null;
}
export type SourceLines = Readonly<Record<string, SourceLine>>;

export function sourceLineFor(
  productId: string,
  sourceLines: SourceLines | undefined,
  draftItems: ReadonlyArray<{ productId?: string | null }>,
): SourceLine | undefined {
  const src = sourceLines?.[productId];
  if (src === undefined) return undefined;
  const { unitsPerBox: pack, unitPrice, originalPrice } = src;
  if (pack !== null && (!Number.isInteger(pack) || pack <= 1)) {
    throw new BadRequestException({
      code: API_ERROR_CODES.SOURCE_LINE_INVALID,
      message: `The source pack for product ${productId} is not a real box size (${pack}).`,
    });
  }
  if (
    !Number.isFinite(unitPrice) ||
    unitPrice < 0 ||
    (originalPrice !== null && !Number.isFinite(originalPrice))
  ) {
    throw new BadRequestException({
      code: API_ERROR_CODES.SOURCE_LINE_INVALID,
      message: `The source price for product ${productId} is not a valid amount.`,
    });
  }
  if (draftItems.filter((i) => i.productId === productId).length > 1) {
    throw new BadRequestException({
      code: API_ERROR_CODES.SOURCE_LINE_AMBIGUOUS,
      message: `Product ${productId} appears on more than one line, so a source line cannot be applied to a single one.`,
    });
  }
  return src;
}
