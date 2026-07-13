import { IsString, IsOptional, IsNumber, IsDateString, Max, Min, NotEquals } from "class-validator";
import { Type } from "class-transformer";

export class RecordAdjustmentDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Type(() => Number)
  @NotEquals(0, { message: "Adjustment quantity cannot be zero" })
  @Min(-9999999.999) // quantity column is Decimal(10,3)
  @Max(9999999.999)
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
