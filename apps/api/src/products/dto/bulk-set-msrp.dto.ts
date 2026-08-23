import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * POST /products/msrp/bulk body — mirrors BulkSetCostBasisDto's shape. Each
 * item's `msrp` may be `null` to explicitly clear that product's MSRP back to
 * "no MSRP" (blank, never $0.00); the service normalizes 0/negative the same way.
 */
export class BulkSetMsrpItemDto {
  @IsString()
  productId: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  msrp: number | null;
}

export class BulkSetMsrpDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkSetMsrpItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  items: BulkSetMsrpItemDto[];
}
