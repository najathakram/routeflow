import {
  ArrayMinSize,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class BulkSetCostBasisItemDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Min(0)
  @Max(999999.9999) // unitCost column is Decimal(10,4)
  @Type(() => Number)
  unitCost: number;
}

export class BulkSetCostBasisDto {
  @ValidateNested({ each: true })
  @Type(() => BulkSetCostBasisItemDto)
  @ArrayMinSize(1)
  items: BulkSetCostBasisItemDto[];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  applyToLots?: boolean;
}
