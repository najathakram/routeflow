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
  ValidateIf,
  ValidateNested,
} from "class-validator";

// Decimal(10,2): at most 8 integer digits, so an over-range value is a 400, never a DB overflow 500.
const MONEY = /^\d{1,8}(\.\d+)?$/;

// Decimal(10,4): at most 6 integer digits.
const COST = /^\d{1,6}(\.\d+)?$/;

// An explicit null is NOT "omitted": it must fail the money rule, never silently write $0 (Tier 1, #2881 r3).
/** Readable messages for a null (Tier 1, #2881 r3): a price is required; an optional amount is omitted, never null. */
const moneyMessage = (field: string, required: boolean) => (a: { value?: unknown }) =>
  a.value == null
    ? required
      ? `${field} is required`
      : `${field} cannot be null; omit the field to leave it unchanged`
    : `${field} must be a non-negative amount`;

const notUndefined = (_o: unknown, v: unknown): boolean => v !== undefined;

/**
 * SA-606g: the ONE create-side blank rule. null / "" / whitespace-only means OMITTED (a variant then inherits the family
 * cost, a family has none); a string is trimmed; a non-string passes through unchanged (and is rejected). Used as the DTO @Transform AND by the service, so HTTP and a caller
 * that bypasses the DTO behave identically. Update rows and every price stay STRICT (null / "" is a 400).
 */
export const blankToUndefined = (v: unknown): unknown => {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim().length > 0 ? v.trim() : undefined;
  // ANYTHING else (a JSON number, boolean, object) passes through UNCHANGED so the validator rejects it: only a blank or null
  // means "omitted"; a non-string must never silently inherit the family cost.
  return v;
};

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value;

/** One variant row of POST /products/families and the `add` rows of PATCH /products/:id/variants. */
export class FamilyVariantDto {
  @Transform(trimmed) @IsString() @IsNotEmpty() name: string;
  @IsOptional() @Transform(trimmed) @IsString() sku?: string;
  @IsOptional() @Transform(trimmed) @IsString() barcode?: string;
  @IsOptional() @Transform(trimmed) @IsString() unitSku?: string;
  @IsOptional() @IsInt() @Min(1) unitsPerBox?: number;
  @Matches(MONEY, { message: moneyMessage("pricePerUnit", true) }) pricePerUnit: string;
  @IsOptional()
  @Transform(({ value }) => blankToUndefined(value))
  @Matches(COST, { message: moneyMessage("standardCost", false) })
  standardCost?: string;
}

export class FamilyInfoDto {
  @Transform(trimmed) @IsString() @IsNotEmpty() name: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  /** SA-606i: REQUIRED on create (no implicit $0.00); an explicit "0.00" is a deliberate free family. */
  @Matches(MONEY, { message: moneyMessage("pricePerUnit", true) })
  pricePerUnit: string;
  /** SA-606a: optional family cost; a variant that omits its own standardCost inherits it (no copy flag). */
  @IsOptional()
  @Transform(({ value }) => blankToUndefined(value))
  @Matches(COST, { message: moneyMessage("standardCost", false) })
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
  @IsOptional() @Transform(trimmed) @IsString() sku?: string;
  @IsOptional() @Transform(trimmed) @IsString() barcode?: string;
  @IsOptional() @Transform(trimmed) @IsString() unitSku?: string;
  @IsOptional() @IsInt() @Min(1) unitsPerBox?: number;
  @ValidateIf(notUndefined)
  @Matches(MONEY, { message: moneyMessage("pricePerUnit", false) })
  pricePerUnit?: string;
  @ValidateIf(notUndefined)
  @Matches(COST, { message: moneyMessage("standardCost", false) })
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
