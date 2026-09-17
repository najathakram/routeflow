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

  /**
   * A BARE `qty` (both `boxes`/`pieces` omitted) is interpreted per `returnRequestPieces`:
   * for a boxed product it means SELLING UNITS (boxes), not raw pieces — `qty: 1` on a
   * 12-pack product returns one whole BOX (12 pieces), never one loose piece. To return
   * loose pieces of a boxed product, supply `boxes`/`pieces` explicitly (e.g.
   * `{ boxes: 0, pieces: 3 }`). This mirrors the same box-vs-piece axis convention already
   * used for line storage (`OrderItem`/`InvoiceItem`) — see design.md §3.1.
   */
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
