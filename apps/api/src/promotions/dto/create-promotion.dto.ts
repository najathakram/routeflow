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
 * PERCENT / FIXED / QTY_BREAK / BUY_N_GET_M, scoped to ALL / a CATEGORY / an explicit
 * PRODUCTS set. The pricing engine (pricing.ts) applies the value at cart time — never
 * here. BUY_N_GET_M ("buy 5, get the 6th free") reuses minQty (=N, buy quantity) and
 * value (=M, free quantity) — no dedicated columns; both required as positive integers
 * for this type, enforced in PromotionsService.validateRule (not a decorator, since the
 * requirement is conditional on `type`).
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

  /**
   * PERCENT: 0-100. FIXED: dollars off per selling unit. QTY_BREAK: percent off at/over
   * minQty. BUY_N_GET_M: M — the free quantity (integer >= 1; "get M of every N+M free").
   */
  @IsNumber()
  @Min(0)
  value!: number;

  /**
   * QTY_BREAK: threshold (pieces) for the price break. BUY_N_GET_M: N — the buy quantity
   * (integer >= 1 selling units — boxes for a boxed product). Ignored otherwise.
   */
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
