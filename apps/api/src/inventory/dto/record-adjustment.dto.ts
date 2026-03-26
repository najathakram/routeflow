import { IsString, IsOptional, IsNumber, IsDateString, NotEquals } from "class-validator";
import { Type } from "class-transformer";

export class RecordAdjustmentDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Type(() => Number)
  @NotEquals(0, { message: "Adjustment quantity cannot be zero" })
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
