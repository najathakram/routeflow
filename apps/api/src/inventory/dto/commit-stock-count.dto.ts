import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export type StockCountMode = "REPLACE" | "ADD";

export class CommitStockCountItemDto {
  @IsString()
  productId: string;

  @IsNumber()
  @Type(() => Number)
  @Min(0)
  @Max(9999999.999) // quantity column is Decimal(10,3)
  quantity: number;

  @IsIn(["REPLACE", "ADD"])
  mode: StockCountMode;
}

export class CommitStockCountDto {
  @IsUUID()
  sessionId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CommitStockCountItemDto)
  items: CommitStockCountItemDto[];

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}
