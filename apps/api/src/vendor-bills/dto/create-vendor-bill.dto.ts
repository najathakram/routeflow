import { IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested } from "class-validator";
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
  /** Sales tax on the supplier invoice — folded into totalOwed server-side. */
  @IsOptional() @IsNumber() @Min(0) taxAmount?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VendorBillItemDto)
  items?: VendorBillItemDto[];
}
