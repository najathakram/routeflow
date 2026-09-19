import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

/**
 * "Omitted is fine, but an explicit null is not" — `@IsOptional()` would let null through to a
 * NOT NULL column (a 500). Prices keep `@IsOptional()` because null legitimately means "derived".
 */
const NotNull = () => ValidateIf((_o, v) => v !== undefined);

// Decimal(10,2) ceiling.
const MAX_PRICE = 99_999_999.99;

/**
 * A `ProductUnit` level (units_v1): a selling unit above/below the pack — Case, Pallet, or an
 * explicit "Piece" price row. `factorToBase` is pieces per ONE of this unit. A NULL/omitted price
 * means "derived" (see `resolveUnitPrice` in @routeflow/pricing); `0` is treated as inherit too.
 */
export class CreateProductUnitDto {
  @IsString() @MaxLength(40) label: string;
  @IsInt() @Min(1) @Max(1_000_000) factorToBase: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRICE) price?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  priceTier2?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  priceTier3?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  priceTier4?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  priceTier5?: number | null;
  @IsOptional() @IsBoolean() isDefaultSelling?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}

/** PATCH body — every field optional; `factorToBase` is refused once a line carries the level. */
export class UpdateProductUnitDto {
  @NotNull() @IsString() @MaxLength(40) label?: string;
  @NotNull() @IsInt() @Min(1) @Max(1_000_000) factorToBase?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_PRICE) price?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  priceTier2?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  priceTier3?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  priceTier4?: number | null;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_PRICE)
  priceTier5?: number | null;
  @NotNull() @IsBoolean() isDefaultSelling?: boolean;
  @NotNull() @IsInt() @Min(0) @Max(1000) sortOrder?: number;
}
