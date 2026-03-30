import { IsUUID, IsDecimal, IsOptional, IsString } from "class-validator";

export class UpsertCustomerPriceDto {
  @IsUUID()
  productId: string;

  @IsDecimal()
  specialPrice: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
