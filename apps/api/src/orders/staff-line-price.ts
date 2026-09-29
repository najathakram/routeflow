/**
 * #2716c / SA-558c / SA-558d — the order-edit call sites' adapters over THE staff price-override
 * rule, `decideStaffOverride` (@routeflow/pricing): within half a cent of the baseline is not an
 * override; a special-tier change needs a reason; otherwise below list => DISCOUNTED, at or above
 * list => MANUAL, originalPrice = LIST, price rounded to cents. Each arm only chooses its own
 * baseline: the line's STORED price for an existing-line edit (B), the customer's TIER price for a
 * line added during an edit (C) and for a replaceAll line with no stored counterpart. Forward-only:
 * an untouched line keeps its stored type. The only MANUAL stamped here without the shared rule is
 * the unlisted line (no list price exists).
 */
import { BadRequestException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import { decideStaffOverride, roundMoney } from "@routeflow/pricing";

export interface StaffPricedLine {
  priceType: PriceType;
  unitPrice: number;
  originalPrice: number | null;
}

function decideOrRefuse(input: {
  overridePrice: number;
  baselinePrice: number;
  listPrice: number;
  isSpecialTier: boolean;
  hasReason: boolean;
  productName?: string | null;
}): StaffPricedLine {
  const d = decideStaffOverride(input);
  if ("refused" in d) {
    throw new BadRequestException(
      `A reason is required to change ${input.productName ?? "this line"} — it's this customer's special price`,
    );
  }
  return d;
}

/** True for a genuine override (DISCOUNTED / MANUAL) — drives override attribution. */
export const isOverride = (d: Pick<StaffPricedLine, "priceType">) =>
  d.priceType === "DISCOUNTED" || d.priceType === "MANUAL";

/** (B) existing-line edit. `null` = the line is untouched (no price sent, or within ½¢ of stored). */
export function decideEditedLinePrice(input: {
  overridePrice: number | null;
  storedPrice: number;
  listPrice: number;
  isSpecialTier: boolean;
  /** A reason sent with the edit OR already on the line. */
  hasReason: boolean;
  isUnlisted: boolean;
  productName?: string | null;
}): StaffPricedLine | null {
  const { overridePrice, storedPrice } = input;
  if (overridePrice === null || Math.abs(overridePrice - storedPrice) <= 0.005) return null;
  if (input.isUnlisted) {
    return {
      priceType: PriceType.MANUAL,
      unitPrice: roundMoney(overridePrice),
      originalPrice: null,
    };
  }
  return decideOrRefuse({ ...input, overridePrice, baselinePrice: storedPrice });
}

/** (C) add-line-during-edit: baseline = the customer's tier price for the product. */
export function decideAddedLinePrice(input: {
  overridePrice: number;
  tierPrice: number;
  listPrice: number;
  isSpecialTier: boolean;
  hasReason: boolean;
  productName?: string | null;
}): StaffPricedLine {
  return decideOrRefuse({ ...input, baselinePrice: input.tierPrice });
}

/**
 * replaceAll changed-price arm. With a stored counterpart the baseline is its stored price and an
 * echo (within ½¢) is preserved verbatim (`repriced: false`); with none, the tier price. `repriced`
 * is true only for a genuine override (DISCOUNTED / MANUAL): it drives override attribution.
 */
export function decideReplaceAllLinePrice(input: {
  overridePrice: number;
  existing: { unitPrice: number; priceType: string; originalPrice: number | null } | null;
  tierPrice: number;
  listPrice: number;
  isSpecialTier: boolean;
  hasReason: boolean;
  /** The staff create-merge's brand-new lines were never reason-checked. */
  skipReasonGuard: boolean;
  productName?: string | null;
}): StaffPricedLine & { repriced: boolean } {
  const { existing, overridePrice } = input;
  if (existing && Math.abs(overridePrice - existing.unitPrice) <= 0.005) {
    return {
      priceType: existing.priceType as PriceType,
      unitPrice: existing.unitPrice,
      originalPrice: existing.originalPrice,
      repriced: false,
    };
  }
  const d = decideOrRefuse({
    overridePrice,
    baselinePrice: existing ? existing.unitPrice : input.tierPrice,
    listPrice: input.listPrice,
    isSpecialTier: input.isSpecialTier,
    hasReason: input.hasReason || input.skipReasonGuard,
    productName: input.productName,
  });
  return { ...d, repriced: isOverride(d) };
}
