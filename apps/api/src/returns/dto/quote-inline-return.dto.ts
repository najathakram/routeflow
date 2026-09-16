import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";

export class QuoteInlineReturnItemDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  /** Raw qty (pieces, or selling units when `boxes`/`pieces` are both omitted and the
   * product is boxed — see `returnRequestPieces`). */
  @IsInt()
  @Min(1)
  qty!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  boxes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  pieces?: number;
}

export class QuoteInlineReturnDto {
  @IsString()
  @IsNotEmpty()
  customerId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuoteInlineReturnItemDto)
  items!: QuoteInlineReturnItemDto[];

  /** Required for a DRIVER caller (M8): the stop this return is being captured at —
   * proves the caller is at a customer's stop on their own IN_PROGRESS run. Ignored
   * for OPERATOR/TENANT_ADMIN callers. */
  @IsOptional()
  @IsString()
  routeRunStopId?: string;
}
