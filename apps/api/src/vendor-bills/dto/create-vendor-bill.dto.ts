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
 * One line on a vendor bill. Every field is optional so the same shape covers
 * the web create form ({ productId?, description, qty, unitCost }) and the
 * scan/import flows (which also carry `name`/`unitPrice` fallbacks the service
 * reads). Typing it lets the global ValidationPipe strip unknown props instead
 * of forwarding a free-form `any` straight into Prisma (F4-003).
 */
export class VendorBillItemDto {
  @IsOptional() @IsString() productId?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() qty?: number;
  @IsOptional() @IsNumber() unitCost?: number;
  @IsOptional() @IsNumber() unitPrice?: number;
  /** The supplier's own item code, as printed — the strongest signal for matching this line next scan. */
  @IsOptional() @IsString() sku?: string;
  /** Units per box/case, only when the line explicitly printed one. */
  @IsOptional() @IsNumber() @Min(0) packSize?: number;
  @IsOptional() @IsNumber() lineTotal?: number;
}

/**
 * POST /vendor-bills body. F4-003: replaces the untyped `@Body() any` so the
 * global whitelist/forbidNonWhitelisted/transform pipe actually validates the
 * request. Internal callers (import/bookkeeping) call the service directly with
 * `requireSupplier`/`totalOwed` and bypass this DTO, so those stay off the HTTP
 * contract.
 */
export class CreateVendorBillDto {
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() purchaseOrderId?: string;
  @IsOptional() @IsString() billDate?: string;
  @IsOptional() @IsString() dueDate?: string;
  @IsOptional() @IsString() notes?: string;
  /** Sales tax on the supplier invoice — folded into totalOwed AND persisted. */
  @IsOptional() @IsNumber() @Min(0) taxAmount?: number;
  /** Pre-tax total as printed. Stored only; totalOwed still comes from the lines. */
  @IsOptional() @IsNumber() @Min(0) subtotal?: number;
  /** The InvoiceScan this bill was posted from — marks that scan POSTED. */
  @IsOptional() @IsString() scanId?: string;
  /** The supplier's own invoice number; stored normalized and used for dedup. */
  @IsOptional() @IsString() supplierInvoiceNumber?: string;
  /** Operator override after the duplicate warning — records the bill anyway. */
  @IsOptional() @IsBoolean() allowDuplicate?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VendorBillItemDto)
  items?: VendorBillItemDto[];
}
