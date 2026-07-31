import {
  IsBoolean,
  IsDecimal,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";
import { Transform } from "class-transformer";
import { CostingMethod } from "@prisma/client";
import {
  emptyToNull,
  emptyToUndefined,
  toOptionalDecimalString,
} from "../../common/dto-transforms";

export class CreateProductDto {
  @IsString() name: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  // Optional retail-unit (inner piece) code; unset ⇒ read sites fall back to the
  // case `sku`. "" is treated as absent, same as a form that never touched the field.
  @IsOptional() @Transform(emptyToUndefined) @IsString() unitSku?: string;
  @IsString() unit: string;
  // Coerce a numeric price (mobile sends a number) to the decimal string Prisma
  // wants — the tier fields below already do this; the base price was missed,
  // which 400'd every mobile product create/edit.
  @Transform(toOptionalDecimalString)
  @IsDecimal()
  @Matches(/^\d+(\.\d+)?$/, { message: "pricePerUnit must be non-negative" })
  pricePerUnit: string; // Decimal as string for Prisma
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Requires the tenant's "tobacco_dealer" addon to set true. */
  @IsOptional() @IsBoolean() isTobacco?: boolean;
  @IsOptional() @IsEnum(CostingMethod) costingMethod?: CostingMethod;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() standardCost?: string;
  @IsOptional() @IsInt() unitsPerBox?: number;
  // Tolerant tiers: "" → absent, numbers coerced to strings ("" used to 400 the
  // whole save — see fix/tier-pricing-save).
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier2?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier3?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier4?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier5?: string;
  @IsOptional() @Transform(emptyToUndefined) @IsUUID() parentProductId?: string;
  @IsOptional() @IsString() variantName?: string;
  // Phase 4 (subcategories): optional regulated section + finer subcategory.
  // emptyToNull so an empty select CLEARS the tag; the service validates that the
  // subcategory belongs to the chosen section.
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
