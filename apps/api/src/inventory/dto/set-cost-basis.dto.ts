import { IsBoolean, IsNumber, IsOptional, IsString, Min } from "class-validator";
import { Type } from "class-transformer";

export class SetCostBasisDto {
  @IsNumber()
  @Min(0)
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
