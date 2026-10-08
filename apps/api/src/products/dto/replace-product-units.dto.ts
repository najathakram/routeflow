import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateNested,
} from "class-validator";

// Decimal(10,2) ceiling, same as the single-level DTOs.
const MAX_PRICE = 99_999_999.99;

/** Tier 2..5 prices: up to 4 entries, each a price with at most 2 decimals or null (= derived). */
const IsTierList = () =>
  ValidateBy({
    name: "isTierList",
    validator: {
      validate: (v: unknown) =>
        v == null ||
        (Array.isArray(v) &&
          v.length <= 4 &&
          v.every(
            (n) =>
              n === null ||
              (typeof n === "number" &&
                Number.isFinite(n) &&
                n >= 0 &&
                n <= MAX_PRICE &&
                Math.round(n * 100) / 100 === n),
          )),
      defaultMessage: () => "tiers must be up to 4 prices (or null) with at most 2 decimals",
    },
  });

/** One chain row: "[perParent] [left] = 1 [label]". `parentLabel` null = built on the base unit. */
export class LadderLevelDto {
  @IsString() @MaxLength(40) label: string;
  // Range/whole-number rules live in flattenLadder so the editor and the API give one answer; here only the type.
  @IsInt() perParent: number;
  @IsOptional() @IsString() @MaxLength(40) parentLabel?: string | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRICE) price?: number | null;
  /** Tier 2..5 prices, in order; null = derived. */
  @IsOptional() @IsTierList() tiers?: Array<number | null>;
  @IsBoolean() isDefaultSelling: boolean;
  @IsInt() @Min(0) @Max(1000) sortOrder: number;
  @IsOptional() @IsString() barcode?: string | null;
  @IsOptional() @IsString() sku?: string | null;
}

/** The base unit's own price row and unit code (stored as the legacy Piece row / Product.unitSku). */
export class LadderBaseDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRICE) price?: number | null;
  @IsOptional() @IsTierList() tiers?: Array<number | null>;
  @IsOptional() @IsBoolean() isDefaultSelling?: boolean;
  @IsOptional() @IsString() sku?: string | null;
}

/** PUT /products/:id/units: replace the whole ladder in ONE transaction. */
export class ReplaceProductUnitsDto {
  @IsOptional() @IsString() @MaxLength(40) baseUnitLabel?: string | null;
  @IsOptional() @IsString() @MaxLength(40) packLabel?: string | null;
  @IsOptional() @IsString() @MaxLength(40) packLevel?: string | null;
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => LadderLevelDto)
  levels: LadderLevelDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(24) @IsString({ each: true }) newUnits?: string[];
  /** Omitted = keep any existing Piece price row; null = remove it. */
  @IsOptional() @ValidateNested() @Type(() => LadderBaseDto) base?: LadderBaseDto | null;
}
