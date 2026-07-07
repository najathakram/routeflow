import { IsOptional, IsString, MaxLength } from "class-validator";

/** Body for `POST /import/aliases` — learn a raw-text → product/category mapping. */
export class CreateAliasDto {
  /** Supplier scope; omit / empty = applies to any supplier. */
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
