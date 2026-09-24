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
import { RequireBoxesOrPiecesPositive } from "./require-boxes-or-pieces.validator";

export class QuoteInlineReturnItemDto {
  @IsString()
  @IsNotEmpty()
  productId!: string;

  /**
   * SA-128/B814: `boxes`/`pieces` are REQUIRED, and bare `qty` is retired on this endpoint.
   * A product can have no `unitsPerBox` anywhere (no live snapshot, no candidate invoice
   * line with one either) for two reasons that look identical from here: it's genuinely
   * never sold in boxes (`qty` would correctly mean pieces), or it WAS boxed and that
   * information was lost (`qty` was meant as boxes, and silently reading it as pieces
   * under-credits the customer by a factor of the pack size). Nothing in the request or the
   * order history can tell those two apart, so guessing is unsafe either way — every caller
   * must state the split explicitly, even for an unpacked line (`{ boxes: 0, pieces: N }`).
   * `qty` is still accepted (existing callers send `qty: 1`) but is IGNORED once
   * `boxes`/`pieces` are present, which they now always must be.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  qty?: number;

  @IsInt()
  @Min(0)
  @RequireBoxesOrPiecesPositive()
  boxes!: number;

  @IsInt()
  @Min(0)
  pieces!: number;
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
