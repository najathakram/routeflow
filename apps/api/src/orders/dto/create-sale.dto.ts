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
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

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

  /**
   * Delivery-date picker: when present it REPLACES `deliveredNow`'s binary.
   *  - deliveredOn <= today (tenant-tz calendar compare) → behaves as deliveredNow=true
   *    AND sets deliveredAt to that date (staff-only backdating, same gate as orderDate).
   *  - deliveredOn > today → behaves as deliveredNow=false and sets
   *    requestedDeliveryDate = deliveredOn.
   * `deliveredNow` is still accepted for backward compat (mobile/older clients); when
   * both are present, `deliveredOn` wins.
   */
  @IsOptional() @IsDateString() deliveredOn?: string;

  @IsOptional() @StripHtml() @IsString() @MaxLength(5000) notes?: string;
  @IsOptionalNotNull() @IsNumber() @Min(0) @Max(1_000_000) discountAmount?: number;
  /** Optional flat shipping fee added to the order total (never taxed). */
  @IsOptionalNotNull() @IsNumber() @Min(0) @Max(1_000_000) shippingFee?: number;
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

  /** Explicit invoice due date (ISO). Omitted → tenant default term (e.g. Net 30) applies. */
  @IsOptional() @IsDateString() dueDate?: string;
  /** Long-form Terms & Conditions text for the invoice. Omitted → tenant default applies. */
  @IsOptional() @IsString() @MaxLength(5000) terms?: string;
  /**
   * Structured "Net 30"-style label shown alongside dueDate — distinct from
   * `terms` above (the long-form T&C text). Whatever term the operator picked to
   * compute `dueDate` on the New Sale screen belongs here, so label and math can
   * never disagree. Omitted → the invoice is labeled with the resolved default
   * term (customer override, else tenant default).
   */
  @IsOptional() @IsString() @MaxLength(40) paymentTermsLabel?: string;

  /** Credit notes to apply to this order's invoice(s). undefined = leave untouched;
   *  [] = remove all; otherwise the FULL desired set (server diffs). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AppliedCreditNoteDto)
  appliedCreditNotes?: AppliedCreditNoteDto[];

  /**
   * INTERNAL (SA-655): the counter sale sets this in code, never from a request body. It becomes the
   * order's Idempotency-Key; with it createSale RESUMES a replayed sale instead of starting over.
   *
   * Why `declare` (B1224): this field has no validator on purpose, so a body-sent value must be refused
   * by the global whitelist. But the api targets ES2023 (class fields use define semantics), so a plain
   * `idempotencyKey?: string;` is emitted as an own `undefined` property on every instance, and
   * forbidNonWhitelisted then rejects EVERY request with 400 "property idempotencyKey should not exist".
   * `declare` keeps the type and emits no field, so only a client-sent key is refused.
   */
  declare idempotencyKey?: string;
}
