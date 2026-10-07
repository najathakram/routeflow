import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsUUID,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import {
  RF_INVOICE_SEND_MAX_IDS,
  RF_INVOICE_VIEW_VALUES,
} from "../../billing/rf-invoice/rf-invoice.constants";
import { EXTERNAL_PAYMENT_METHODS, type ExternalPaymentMethod } from "./activate-subscription.dto";

export const RF_INVOICE_SORT_VALUES = ["due", "amount", "tenant"] as const;

/** GET /platform-admin/rf-invoices. */
export class RfInvoiceListQueryDto {
  @IsOptional()
  @IsIn(RF_INVOICE_VIEW_VALUES)
  view?: (typeof RF_INVOICE_VIEW_VALUES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @IsIn(RF_INVOICE_SORT_VALUES)
  sort?: (typeof RF_INVOICE_SORT_VALUES)[number];

  @IsOptional()
  @IsIn(["asc", "desc"])
  dir?: "asc" | "desc";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** POST rf-invoices/:id/mark-paid. The reference / date rules are coded 400s in the service. */
export class MarkRfInvoicePaidDto {
  /** ISO date or datetime; not in the future, not more than 60 days back. Defaults to now. */
  @IsOptional()
  @IsISO8601()
  paidAt?: string;

  @IsIn(EXTERNAL_PAYMENT_METHODS)
  method!: ExternalPaymentMethod;

  /** Required for ZELLE, BANK_TRANSFER and WIRE. Never a card or full account number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** POST rf-invoices/:id/reopen and :id/void. */
export class RfInvoiceReasonDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** POST rf-invoices/send: one to fifty invoice ids. */
export class SendRfInvoicesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(RF_INVOICE_SEND_MAX_IDS)
  @IsUUID("all", { each: true })
  ids!: string[];
}
