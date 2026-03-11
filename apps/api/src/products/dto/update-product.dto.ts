import { IsBoolean, IsDecimal, IsOptional, IsString } from "class-validator";

export class UpdateProductDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() unit?: string;
  @IsOptional() @IsDecimal() pricePerUnit?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() lowStock?: boolean;
}
