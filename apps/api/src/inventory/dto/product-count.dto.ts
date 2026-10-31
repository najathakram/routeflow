import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
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
} from "class-validator";
import { Type } from "class-transformer";
import { AdjustmentReasonDto } from "./adjustment-reason.dto";

/** The most pieces / units one count line may name (the quantity column is Decimal(10,3)). */
const MAX_COUNT_QTY = 9_999_999;

/** The most parts one count may name (at most one per ladder level; no ladder is this deep). */
const MAX_COUNT_PARTS = 10;

/** One part of a count: how many of `unit`. Zero is a real count (none of that unit left). */
export class ProductCountPartDto {
  /** A ladder label ("Case", "Piece"); null / absent = the product's own pack. Never a factor. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  unit?: string | null;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Type(() => Number)
  @Min(0)
  @Max(MAX_COUNT_QTY)
  quantity: number;
}

/** A unit's identity within one request: trimmed, case-folded; null / blank = the pack. */
const partKey = (p: unknown) => {
  const unit = (p as { unit?: unknown } | null)?.unit;
  return typeof unit === "string" ? unit.trim().toLowerCase() : "";
};

/**
 * SA-828 (row 657) + SA-828a: `POST /inventory/products/:id/count`. Mirrors `ProductCountRequest`
 * (packages/types/api/product-count.ts). The count takes `parts` ("3 cases + 4 boxes"); each unit at
 * most once (a duplicate is 400). The server resolves every factor from the product's ladder inside
 * the write's transaction; there is deliberately no factor field (the global pipe rejects one).
 * SET: the summed pieces are the counted total. ADJUST: one `sign` for the whole delta.
 */
export class ProductCountDto extends AdjustmentReasonDto {
  @IsIn(["SET", "ADJUST"])
  mode: "SET" | "ADJUST";

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_COUNT_PARTS)
  @ArrayUnique(partKey, { message: "parts must name each unit once" })
  @ValidateNested({ each: true })
  @Type(() => ProductCountPartDto)
  parts: ProductCountPartDto[];

  /** ADJUST only: the direction of the whole delta (the parts stay non-negative). */
  @ValidateIf((o: ProductCountDto) => o.mode === "ADJUST" || o.sign !== undefined)
  @IsIn(["+", "-"])
  sign?: "+" | "-";

  @IsOptional()
  @IsDateString()
  effectiveDate?: string;
}
