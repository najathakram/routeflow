import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * One line of a partial receive: how much of the bill line arrived, in the
 * line's own denomination (cases when packSize > 1, pieces otherwise) —
 * the same unit `qty` is printed in.
 */
export class ReceiveVendorBillLineDto {
  @IsString() itemId!: string;
  @IsNumber() @Min(0.001) qty!: number;
}

/**
 * POST /vendor-bills/:id/receive body. Everything optional so existing
 * callers (mobile, older web bundles) that POST `{}` keep full-receive
 * semantics: no `items` = receive the full remaining quantity on every
 * product-linked line.
 */
export class ReceiveVendorBillDto {
  /** Operator confirmed that unlinked lines won't update stock or costs. */
  @IsOptional() @IsBoolean() acknowledgeUnlinked?: boolean;

  /** Per-line quantities for a partial receive. Omit to receive everything remaining. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceiveVendorBillLineDto)
  items?: ReceiveVendorBillLineDto[];
}
