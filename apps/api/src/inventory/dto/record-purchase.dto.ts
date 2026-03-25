import { IsString, IsOptional, IsNumber, IsPositive, IsDateString } from "class-validator";
import { Type } from "class-transformer";

export class RecordPurchaseDto {
  @IsString()
  productId: string;

  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  quantity: number;

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
