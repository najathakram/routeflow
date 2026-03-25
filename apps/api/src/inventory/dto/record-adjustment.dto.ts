import { IsString, IsOptional, IsNumber, IsDateString } from "class-validator";
import { Type } from "class-transformer";

export class RecordAdjustmentDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Type(() => Number)
  quantity: number; // can be negative

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}
