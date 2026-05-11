import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
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
