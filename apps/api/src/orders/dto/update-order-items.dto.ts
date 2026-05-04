import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { StripHtml } from "../../common/transforms/strip-html.transform";

class UpdateOrderItemDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  @IsOptional()
  @IsIn(["CANCEL", "UPDATE"])
  action?: "CANCEL" | "UPDATE";

  @IsOptional()
  @IsNumber()
  @Min(1)
  qty?: number;

  /**
   * Box/piece split for products with `unitsPerBox > 1`. When EITHER is
   * present the server recomputes `qty` from them (boxes × unitsPerBox +
   * pieces) and uses BOX-price proration for the line subtotal — matching
   * the create-order flow. Operator/driver roles only; the customer-edit
   * branch ignores these fields.
   */
  @IsOptional() @IsInt() @Min(0) @Max(100_000) boxes?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100_000) pieces?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsString()
  substituteProductId?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  itemNote?: string;

  @IsOptional()
  @IsString()
  substitution?: string;

  @IsOptional()
  @IsString()
  overrideReason?: string;
}

export class UpdateOrderItemsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateOrderItemDto)
  items: UpdateOrderItemDto[];

  // RF-110: strip HTML to prevent stored XSS via order notes
  @IsOptional()
  @StripHtml()
  @IsString()
  orderNotes?: string;
}
