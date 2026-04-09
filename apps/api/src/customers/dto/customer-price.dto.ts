import { IsUUID, IsInt, IsOptional, IsString, Min, Max } from "class-validator";

export class UpsertCustomerPriceDto {
  @IsUUID()
  productId: string;

  @IsInt()
  @Min(1)
  @Max(5)
  pricingTier: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
