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
import { CostingMethod } from "@prisma/client";

export class UpdateProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsDecimal() pricePerUnit?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  /** Full replacement of the imageKeys array — used to reorder or set the default image. */
  @IsOptional() @IsArray() @IsString({ each: true }) imageKeys?: string[];
  @IsOptional() @IsEnum(CostingMethod) costingMethod?: CostingMethod;
  @IsOptional() @IsDecimal() standardCost?: string;
  @IsOptional() @IsInt() unitsPerBox?: number;
  @IsOptional() @IsDecimal() priceTier2?: string;
  @IsOptional() @IsDecimal() priceTier3?: string;
  @IsOptional() @IsDecimal() priceTier4?: string;
  @IsOptional() @IsDecimal() priceTier5?: string;
  @IsOptional() @IsUUID() parentProductId?: string;
  @IsOptional() @IsString() variantName?: string;
}
