import {
  IsArray,
  IsBoolean,
  IsDecimal,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";
import { Transform } from "class-transformer";
import { CostingMethod } from "@prisma/client";
import {
  emptyToNull,
  emptyToUndefined,
  toOptionalDecimalString,
} from "../../common/dto-transforms";

/**
 * MSRP-specific transform: "" / null → null (explicit clear, same convention as
 * unitSku's emptyToNull below) while still coercing a bare JS number (mobile
 * sends msrp as a number, not a string) to the decimal string @IsDecimal() wants.
 */
const toOptionalMsrp = ({ value }: { value: unknown }) =>
  value == null || (typeof value === "string" && value.trim() === "")
    ? null
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : value;

export class UpdateProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  // "" clears it back to "same as case code" (emptyToNull ⇒ an explicit null write).
  @IsOptional() @Transform(emptyToNull) @IsString() unitSku?: string | null;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() pricePerUnit?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Buyer merchandising flags (P5-01) — surfaced on catalogue tiles + smart collections. */
  @IsOptional() @IsBoolean() isFeatured?: boolean;
  @IsOptional() @IsBoolean() isNew?: boolean;
  @IsOptional() @IsBoolean() isDeal?: boolean;
  /** Requires the tenant's "tobacco_dealer" addon to set true. */
  @IsOptional() @IsBoolean() isTobacco?: boolean;
  /** Full replacement of the imageKeys array — used to reorder or set the default image. */
  @IsOptional() @IsArray() @IsString({ each: true }) imageKeys?: string[];
  @IsOptional() @IsEnum(CostingMethod) costingMethod?: CostingMethod;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() standardCost?: string;
  // MSRP (suggested retail price) — per PIECE, display-only, never money math.
  // Flag-gated service-side (flag.msrp); "" clears an existing value (emptyToNull
  // ⇒ an explicit null write); 0 is normalized to null service-side too.
  @IsOptional() @Transform(toOptionalMsrp) @IsDecimal() msrp?: string | null;
  @IsOptional() @IsInt() unitsPerBox?: number;
  // Tolerant tiers: "" → absent, numbers coerced to strings ("" used to 400 the
  // whole save — see fix/tier-pricing-save).
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier2?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier3?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier4?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier5?: string;
  @IsOptional() @Transform(emptyToUndefined) @IsUUID() parentProductId?: string;
  @IsOptional() @IsString() variantName?: string;
  // Phase 4 (subcategories): emptyToNull so clearing the select removes the tag.
  @IsOptional() @Transform(emptyToNull) @IsUUID() trackedCategoryId?: string | null;
  @IsOptional() @Transform(emptyToNull) @IsUUID() trackedSubcategoryId?: string | null;

  /**
   * Regulatory reporting config. The vocabulary is validated service-side against
   * the section's reportTemplate (regulated/template-registry.ts). "" clears.
   */
  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  regItemType?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  regUomCase?: string | null;

  @IsOptional()
  @Transform(emptyToNull)
  @IsString()
  @MaxLength(20)
  regUomUnit?: string | null;
}
