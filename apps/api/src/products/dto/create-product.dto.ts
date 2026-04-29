import { IsBoolean, IsDecimal, IsEnum, IsInt, IsOptional, IsString, IsUUID, Matches } from "class-validator";
import { CostingMethod } from "@prisma/client";

export class CreateProductDto {
  @IsString() name: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsString() unit: string;
  @IsDecimal() @Matches(/^\d+(\.\d+)?$/, { message: 'pricePerUnit must be non-negative' }) pricePerUnit: string; // Decimal as string for Prisma
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
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
