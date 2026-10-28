import { ConflictException } from "@nestjs/common";
import {
  priceAuthority,
  type PriceAuthorityLevel,
  type PriceAuthorityMode,
  type PriceAuthorityProduct,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { familyPriceAuthorityError } from "./family-price";

const PRICE_KEYS = ["price", "priceTier2", "priceTier3", "priceTier4", "priceTier5"] as const;

/**
 * Row 749 (owner ruling 10-22, "keep structure, drop prices"), narrowed by SA-1041: a unit write that carries a
 * price key is refused only where `priceAuthority` says the family (or the family page) holds that price, with the
 * same coded 409 the price writer uses. On update even null counts (it would clear a price); on create null means
 * "no price" and the legacy add form sends it. Every other level is the tenant's to price (owner Q1).
 */
export function assertUnitPriceWritable(
  product: PriceAuthorityProduct & { id: string },
  dto: object,
  ctx: { mode: PriceAuthorityMode; level: PriceAuthorityLevel; op: "create" | "update" },
): void {
  const body = dto as Record<string, unknown>;
  if (!PRICE_KEYS.some((k) => (ctx.op === "create" ? body[k] != null : body[k] !== undefined)))
    return;
  const authority = priceAuthority(product, ctx.mode, ctx.level);
  if (authority === "own") return;
  if (authority === "family")
    throw familyPriceAuthorityError(product.parentProductId ?? product.id);
  throw new ConflictException({
    code: API_ERROR_CODES.FAMILY_PRICE_AUTHORITY,
    message: "Family prices are edited on the family page.",
    familyId: product.id,
  });
}
