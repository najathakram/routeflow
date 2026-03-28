import { IsArray, IsBoolean, IsDecimal, IsInt, IsNumber, IsOptional, IsString, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

export class ImportProductItemDto {
  @IsString() name: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsString() unit: string;
  @IsDecimal() pricePerUnit: string; // Decimal as string for Prisma
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsDecimal() currentStock?: string;
  @IsOptional() @IsDecimal() averageCost?: string;
  @IsOptional() @IsInt() reorderPoint?: number;
}

export class ImportProductsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportProductItemDto)
  items: ImportProductItemDto[];
}
