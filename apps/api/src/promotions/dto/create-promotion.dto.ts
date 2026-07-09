import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";
import { PromotionScope, PromotionType } from "@prisma/client";

/**
 * Create a seller merchandising promotion (P5-01). Rules are a TYPED set (no JSON DSL):
 * PERCENT / FIXED / QTY_BREAK, scoped to ALL / a CATEGORY / an explicit PRODUCTS set.
 * The pricing engine (pricing.ts) applies the value at cart time — never here.
 */
export class CreatePromotionDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  bannerText?: string;

  @IsEnum(PromotionType)
  type!: PromotionType;

  /** PERCENT: 0-100. FIXED: dollars off per unit. QTY_BREAK: percent off at/over minQty. */
  @IsNumber()
  @Min(0)
  value!: number;

  /** Threshold (pieces) for QTY_BREAK; ignored otherwise. */
  @IsOptional()
  @IsInt()
  @Min(1)
  minQty?: number;

  @IsEnum(PromotionScope)
  scope!: PromotionScope;

  /** Required when scope = CATEGORY. */
  @IsOptional()
  @IsString()
  category?: string;

  /** Product ids when scope = PRODUCTS. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  productIds?: string[];

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
