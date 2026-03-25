import { IsBoolean, IsDecimal, IsOptional, IsString } from "class-validator";

export class CreateProductDto {
  @IsString() name: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsString() unit: string;
  @IsDecimal() pricePerUnit: string; // Decimal as string for Prisma
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
