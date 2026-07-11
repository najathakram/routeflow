import {
  IsArray,
  IsBoolean,
  IsDecimal,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
} from "class-validator";
import { Transform } from "class-transformer";
import { CostingMethod } from "@prisma/client";
import { emptyToUndefined, toOptionalDecimalString } from "../../common/dto-transforms";

export class UpdateProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
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
  @IsOptional() @IsInt() unitsPerBox?: number;
  // Tolerant tiers: "" → absent, numbers coerced to strings ("" used to 400 the
  // whole save — see fix/tier-pricing-save).
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier2?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier3?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier4?: string;
  @IsOptional() @Transform(toOptionalDecimalString) @IsDecimal() priceTier5?: string;
  @IsOptional() @Transform(emptyToUndefined) @IsUUID() parentProductId?: string;
  @IsOptional() @IsString() variantName?: string;
}
