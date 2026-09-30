import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from "class-validator";

// Decimal(10,2): at most 8 integer digits, so an over-range value is a 400, never a DB overflow 500.
const MONEY = /^\d{1,8}(\.\d+)?$/;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/** One variant row of POST /products/families and the `add` rows of PATCH /products/:id/variants. */
export class FamilyVariantDto {
  @Transform(trimmed) @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() unitSku?: string;
  @IsOptional() @IsInt() @Min(1) unitsPerBox?: number;
  @Matches(MONEY, { message: "pricePerUnit must be non-negative" }) pricePerUnit: string;
  @IsOptional()
  @Matches(MONEY, { message: "standardCost must be non-negative" })
  standardCost?: string;
}

export class FamilyInfoDto {
  @Transform(trimmed) @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional()
  @Matches(MONEY, { message: "pricePerUnit must be non-negative" })
  pricePerUnit?: string;
  /** SA-606a: optional family cost; a variant that omits its own standardCost inherits it (no copy flag). */
  @IsOptional()
  @Matches(MONEY, { message: "standardCost must be non-negative" })
  standardCost?: string;
}

export class CreateFamilyDto {
  @ValidateNested() @Type(() => FamilyInfoDto) family: FamilyInfoDto;
  /** 1..200 rows (>200 is a 400). */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => FamilyVariantDto)
  variants: FamilyVariantDto[];
  @IsOptional() @IsBoolean() copyFamilyPrice?: boolean;
}

/** An `update` row: the variant id + any subset of the editable fields (kind is never editable). */
export class FamilyVariantUpdateDto {
  @IsString() id: string;
  @IsOptional() @Transform(trimmed) @IsString() @IsNotEmpty() name?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() unitSku?: string;
  @IsOptional() @IsInt() @Min(1) unitsPerBox?: number;
  @IsOptional()
  @Matches(MONEY, { message: "pricePerUnit must be non-negative" })
  pricePerUnit?: string;
  @IsOptional()
  @Matches(MONEY, { message: "standardCost must be non-negative" })
  standardCost?: string;
}

/** PATCH /products/:id/variants: ALL-OR-NOTHING; the TOTAL row count (add + update + deactivate) is capped at 200. */
export class UpdateFamilyVariantsDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FamilyVariantDto)
  add?: FamilyVariantDto[];
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FamilyVariantUpdateDto)
  update?: FamilyVariantUpdateDto[];
  @IsOptional() @IsArray() @IsString({ each: true }) deactivate?: string[];
}
