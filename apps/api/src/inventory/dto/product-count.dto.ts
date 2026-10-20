import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  IsDefined,
} from "class-validator";
import { Type } from "class-transformer";
import { AdjustmentReasonDto } from "./adjustment-reason.dto";

/** The most pieces / units one count line may name (the quantity column is Decimal(10,3)). */
const MAX_COUNT_QTY = 9_999_999;

class CountUnitDto {
  /** A ladder label ("Case", "Piece"); null / absent = the product's own pack. Never a factor. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  unit?: string | null;
}

/** SET: how many of `unit` are on the shelf. Zero is a real count (none left). */
export class ProductCountSetDto extends CountUnitDto {
  @IsNumber({ maxDecimalPlaces: 3 })
  @Type(() => Number)
  @Min(0)
  @Max(MAX_COUNT_QTY)
  quantity: number;
}

/** ADJUST: add or remove `quantity` of `unit` (always positive; `sign` carries the direction). */
export class ProductCountDeltaDto extends CountUnitDto {
  @IsNumber({ maxDecimalPlaces: 3 })
  @Type(() => Number)
  @Min(0.001)
  @Max(MAX_COUNT_QTY)
  quantity: number;

  @IsIn(["+", "-"])
  sign: "+" | "-";
}

/**
 * SA-828 (row 657): `POST /inventory/products/:id/count`. Mirrors `ProductCountRequest`
 * (packages/types/api/product-count.ts). The server resolves the unit's factor from the product's
 * ladder; there is deliberately no factor field (the global pipe rejects one).
 */
export class ProductCountDto extends AdjustmentReasonDto {
  @IsIn(["SET", "ADJUST"])
  mode: "SET" | "ADJUST";

  @ValidateIf((o: ProductCountDto) => o.mode === "SET")
  @IsDefined()
  @ValidateNested()
  @Type(() => ProductCountSetDto)
  count?: ProductCountSetDto;

  @ValidateIf((o: ProductCountDto) => o.mode === "ADJUST")
  @IsDefined()
  @ValidateNested()
  @Type(() => ProductCountDeltaDto)
  delta?: ProductCountDeltaDto;

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}
