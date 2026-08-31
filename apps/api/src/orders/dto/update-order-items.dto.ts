import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import { AppliedCreditNoteDto } from "./create-order.dto";

class UpdateOrderItemDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  /**
   * Free-text label for an unlisted (non-catalog) line. Present on a new
   * id-less item when `productId` is omitted, or to rename an existing
   * unlisted line. Catalog items leave this unset.
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  @StripHtml()
  name?: string;

  /**
   * - CANCEL → strike the line off (status CANCELLED, qty 0) but keep the row.
   * - DELETE → hard-remove the line entirely (only when it has not been invoiced
   *   or delivered; otherwise the service falls back to CANCEL to preserve history).
   * - UPDATE → edit qty/price/etc.
   */
  @IsOptional()
  @IsIn(["CANCEL", "DELETE", "UPDATE"])
  action?: "CANCEL" | "DELETE" | "UPDATE";

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
  @Max(1_000_000)
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

  /**
   * When true, the operator path treats `items` as the FULL line set: it deletes
   * existing items and recreates from the payload (the mobile "replace-all"
   * pattern). Otherwise — false OR omitted — items are merged incrementally:
   * id-less entries are appended, existing items not present are left untouched.
   *
   * F30/R10 (B198): explicit-only. The old fallback heuristic ("every item lacks
   * an id" ⇒ replace) is gone — it wiped an order on any id-less "just add these"
   * PATCH that omitted the flag, which is exactly the mobile per-scan shape. A
   * caller that wants a wholesale replace must now say `replaceAll: true` out loud.
   */
  @IsOptional()
  @IsBoolean()
  replaceAll?: boolean;

  // RF-110: strip HTML to prevent stored XSS via order notes
  @IsOptional()
  @StripHtml()
  @IsString()
  orderNotes?: string;

  /** Optional flat shipping fee added to the order total (never taxed). Staff-only. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  shippingFee?: number;

  /** Credit notes to apply to this order's invoice(s). undefined = leave untouched;
   *  [] = remove all; otherwise the FULL desired set (server diffs). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AppliedCreditNoteDto)
  appliedCreditNotes?: AppliedCreditNoteDto[];
}
