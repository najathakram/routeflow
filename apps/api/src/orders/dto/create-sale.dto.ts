import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { StripHtml } from "../../common/transforms/strip-html.transform";
import { AppliedCreditNoteDto, OrderItemDto } from "./create-order.dto";

/**
 * "Sale" = an order plus its invoice created in one step (the operator "bill now" flow).
 *
 *  - deliveredNow=true  → the order is marked DELIVERED and the invoice is issued (SENT)
 *                         immediately. This is the van / cash sale: goods handed over and
 *                         billed on the spot.
 *  - deliveredNow=false → the order is created PENDING and a DRAFT invoice is linked to it.
 *                         The invoice is sent now only when `send` is true; otherwise it
 *                         stays a draft. When the order is later delivered, no second invoice
 *                         is created (OrderItem.invoicedQty already covers the full qty).
 *
 * Either way an Order always exists and Invoice.orderId is set — no floating invoices.
 */
export class CreateSaleDto {
  @IsUUID() customerId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @IsBoolean() deliveredNow: boolean;

  @IsOptional() @StripHtml() @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) discountAmount?: number;
  /** Optional flat shipping fee added to the order total (never taxed). */
  @IsOptional() @IsNumber() @Min(0) @Max(1_000_000) shippingFee?: number;
  @IsOptional() @IsDateString() requestedDeliveryDate?: string;
  /**
   * Business date of the sale — the day it actually happened, for a sale entered
   * late. Staff-only: the service rejects it from any non-OPERATOR/TENANT_ADMIN caller.
   * With deliveredNow it also becomes the order's deliveredAt.
   */
  @IsOptional() @IsDateString() orderDate?: string;

  /**
   * Sales agents & commissions: per-order commission-rate override, threaded to the
   * backing order. `0` IS a valid value ("exempt"). Staff-only, same gate as orderDate.
   */
  @IsOptional() @IsNumber() @Min(0) @Max(100) commissionRatePct?: number;

  /** Only used when deliveredNow=false: issue (send) the draft invoice now instead of leaving it DRAFT. */
  @IsOptional() @IsBoolean() send?: boolean;

  /** Credit notes to apply to this order's invoice(s). undefined = leave untouched;
   *  [] = remove all; otherwise the FULL desired set (server diffs). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AppliedCreditNoteDto)
  appliedCreditNotes?: AppliedCreditNoteDto[];
}
