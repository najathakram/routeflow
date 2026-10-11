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
import { InlineReturnLinesDto } from "../../returns/dto/capture-inline-return.dto";

class UpdateOrderItemDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  productId?: string;

  /**
   * B297 row 352 — BUYER edit only (PATCH /buyer/orders/:id/items): the stored line this entry edits. It keeps
   * the rate it was sold at; an entry without it is a new line (or, for one release, the line of its product
   * when exactly one exists). An id that is not a line of this order, or is another product's, is a 400.
   * Staff edits name a line with `id`; an entry carrying this field there is refused (400), never ignored.
   */
  @IsOptional()
  @IsString()
  orderItemId?: string;

  /**
   * units_v1 (A1): sell by this unit of the product's ladder (Case, Pallet, Piece …). STAFF ONLY,
   * behind flag.units_v1; `qty` then counts the unit and boxes/pieces must be omitted. Absent on
   * an existing unit-aware line's edit is REFUSED (never interpreted), not "keep the old unit" —
   * see unit-line-edit.ts assertUnitLabelNamed.
   */
  @IsOptional() @IsString() @MaxLength(64) unitLabel?: string | null;

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
   * the create-order flow. Operator/driver roles resolve it this way
   * directly; on the buyer (CUSTOMER) edit path — REG-B47 — a present
   * boxes/pieces field instead serves as a denomination SIGNAL (a folded
   * merge payload marking this line piece-denominated), server-re-split from
   * `qty` + the LIVE product `unitsPerBox`, never trusted verbatim (B13).
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
  @MaxLength(2000)
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

  /**
   * B297 row 352 — BUYER edit only: the client names every existing line with `items[].orderItemId`, so an
   * entry without one is a NEW line. Absent = a legacy client: the server falls back to the product's only
   * line when exactly one exists (one release), and 409s `ORDER_EDIT_NEEDS_LINE_IDS` when two or more could be meant.
   */
  @IsOptional()
  @IsBoolean()
  namesLines?: boolean;

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

  /**
   * #2094 (SA-194): a return taken inside this edit's own transaction. Customer and order are DERIVED
   * from the document; `returnKey` is the per-attempt nonce. Staff and driver only: a buyer carrying
   * it is refused before any read (OrdersService).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => InlineReturnLinesDto)
  inlineReturn?: InlineReturnLinesDto;
}
