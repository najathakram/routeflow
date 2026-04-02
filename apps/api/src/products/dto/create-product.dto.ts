import { IsBoolean, IsDecimal, IsEnum, IsInt, IsOptional, IsString } from "class-validator";
import { CostingMethod } from "@prisma/client";

export class CreateProductDto {
  @IsString() name: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsString() unit: string;
  @IsDecimal() pricePerUnit: string; // Decimal as string for Prisma
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsEnum(CostingMethod) costingMethod?: CostingMethod;
  @IsOptional() @IsDecimal() standardCost?: string;
  @IsOptional() @IsInt() unitsPerBox?: number;
}
