import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from "class-validator";

const MONEY = /^\d+(\.\d+)?$/;

/** One variant row of POST /products/families and the `add` rows of PATCH /products/:id/variants. */
export class FamilyVariantDto {
  @IsString() name: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() unitSku?: string;
  @IsOptional() @IsInt() @Min(1) unitsPerBox?: number;
  @Matches(MONEY, { message: "pricePerUnit must be non-negative" }) pricePerUnit: string;
  @IsOptional() @Matches(MONEY, { message: "costPrice must be non-negative" }) costPrice?: string;
}

export class FamilyInfoDto {
  @IsString() name: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional()
  @Matches(MONEY, { message: "pricePerUnit must be non-negative" })
  pricePerUnit?: string;
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
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() sku?: string;
  @IsOptional() @IsString() barcode?: string;
  @IsOptional() @IsString() unitSku?: string;
  @IsOptional() @IsInt() @Min(1) unitsPerBox?: number;
  @IsOptional()
  @Matches(MONEY, { message: "pricePerUnit must be non-negative" })
  pricePerUnit?: string;
  @IsOptional() @Matches(MONEY, { message: "costPrice must be non-negative" }) costPrice?: string;
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
