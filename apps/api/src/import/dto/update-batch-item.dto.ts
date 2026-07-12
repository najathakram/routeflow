import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/** One line's review decision: map it to a product, or explicitly keep it custom. */
export class BatchItemLinePatchDto {
  @IsInt()
  @Min(0)
  index!: number;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsBoolean()
  keepCustom?: boolean;
}

/** Body for `PATCH /import/batch/items/:itemId` — the review-and-fix-up endpoint. */
export class UpdateBatchItemDto {
  @IsOptional()
  @IsString()
  supplierId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchItemLinePatchDto)
  lines?: BatchItemLinePatchDto[];
}
