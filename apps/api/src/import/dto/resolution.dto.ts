import { IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from "class-validator";

/** §5 choice 1 — new variant of an existing product. */
export class CreateVariantDto {
  @IsString()
  parentProductId!: string;

  @IsString()
  @MaxLength(120)
  variantName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;
}

/** §5 choice 2 — brand-new product (minimal, flagged details-incomplete). */
export class CreateBrandNewDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sku?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cost?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  unit?: string;
}

/** §5 choice 3 — match to an existing product / expense category (learns an alias). */
export class MatchExistingDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierId?: string;

  @IsString()
  @MaxLength(500)
  rawText!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  productId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  expenseCategoryId?: string;
}

/** Confirm a brand-new product's details and clear the incomplete flag. */
export class CompleteSetupDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  pricePerUnit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  unit?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  unitsPerBox?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;
}
