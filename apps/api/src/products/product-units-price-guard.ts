import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { familyPriceAuthorityError } from "./family-price";
import { governedReason } from "./product-price-grid.service";

const PRICE_KEYS = ["price", "priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

/**
 * Row 749 (owner ruling 10-22, "keep structure, drop prices"): the unit ladder of a variant, family or
 * recipe may still be edited, but its PRICES belong to the family / recipe. Any price key in the body
 * (even null, which would clear one) is refused with the same coded 409 the price writer uses.
 * The rule itself is `governedReason`, the one source the price grid and the price write share.
 */
export function assertUnitPriceWritable(
  product: { id: string; parentProductId?: string | null; kind?: string | null },
  dto: object,
): void {
  if (!PRICE_KEYS.some((k) => (dto as Record<string, unknown>)[k] !== undefined)) return;
  const reason = governedReason(product);
  if (!reason) return;
  if (product.parentProductId) throw familyPriceAuthorityError(product.parentProductId);
  throw new ConflictException({
    code: API_ERROR_CODES.FAMILY_PRICE_AUTHORITY,
    message: reason,
    familyId: product.id,
  });
}
