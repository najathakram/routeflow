import {
  IsString,
  IsOptional,
  IsNumber,
  IsPositive,
  IsInt,
  Min,
  IsDateString,
} from "class-validator";
import { Type } from "class-transformer";

export class RecordPurchaseDto {
  @IsString()
  productId: string;

  /**
   * Base units (pieces) to receive. Omit when sending `boxes`/`pieces` — the
   * server resolves the received piece quantity from the split instead and
   * `quantity` is then ignored for stock math (InventoryService.recordPurchase).
   * A bare `quantity` KEEPS meaning pieces — existing callers (mobile, import
   * scripts, seeds) are unaffected.
   */
  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  quantity?: number;

  @IsOptional() @IsInt() @Min(0) @Type(() => Number) boxes?: number;
  @IsOptional() @IsInt() @Min(0) @Type(() => Number) pieces?: number;

  /**
   * Cost per SELLING UNIT — a box when `boxes`/`pieces` is sent (mirrors the
   * box-priced selling convention documented in @routeflow/pricing), a piece
   * otherwise. InventoryService.recordPurchase converts to a per-piece cost
   * before AVCO math, since Product.averageCost is contractually per piece.
   */
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  unitCost: number;

  @IsOptional()
  @IsString()
  supplierId?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}
