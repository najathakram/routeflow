import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";

export class SetCostBasisDto {
  @IsNumber()
  @Min(0)
  @Max(999999.9999) // unitCost column is Decimal(10,4) — reject overflow as 400, not a 500
  @Type(() => Number)
  unitCost: number;

  @IsOptional()
  @IsString()
  notes?: string;

  /** Also rewrite the unit cost of all open stock lots (FIFO/LIFO products). */
  @IsOptional()
  @IsBoolean()
  applyToLots?: boolean;
}
