import { IsUUID, IsInt, IsOptional, IsString, IsNumber, Min, Max } from "class-validator";

/**
 * A row may now carry a pricing tier, an MSRP override, or both — the service
 * requires at least one of `pricingTier`/`msrp` to be present (class-validator
 * can't express "at least one of these two optional fields" declaratively).
 * `msrp: null` explicitly clears an existing override; msrp writes are
 * flag-gated the same way as the product-level field (flag.msrp).
 */
export class UpsertCustomerPriceDto {
  @IsUUID()
  productId: string;

  // Explicit null clears the tier back to "use the customer's default tier"
  // (every pricingTier reader already falls back `?? customer default`); an
  // absent key leaves the existing tier untouched.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  pricingTier?: number | null;

  // Never $0.00 — a number must be a real price; null clears the override.
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  msrp?: number | null;

  @IsOptional()
  @IsString()
  notes?: string;
}
