import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type, Transform } from "class-transformer";

export enum StockStatusFilter {
  IN_STOCK = "IN_STOCK",
  LOW = "LOW",
  OUT_OF_STOCK = "OUT_OF_STOCK",
}

export class ListProductsDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isActive?: boolean;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() isTobacco?: boolean;
  @IsOptional() @IsEnum(StockStatusFilter) stockStatus?: StockStatusFilter;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  // limit=0 is the "fetch-all" sentinel (service caps it at 10_000); web
  // product pickers rely on it and on larger page sizes (500/1000). The old
  // @Min(1)@Max(200) rejected all of those with 400, leaving pickers empty.
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10000) limit?: number;
  @IsOptional() @Transform(({ value }) => value === "true") @IsBoolean() includeVariants?: boolean;
}
