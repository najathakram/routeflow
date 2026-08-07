import { IsNumber, IsOptional, IsString } from "class-validator";

/**
 * POST /vendor-bills/check-duplicate body — a read-only pre-flight of the same
 * guard `create()` enforces, so a client can warn before the operator finishes
 * keying a bill. Every field is optional: the matcher needs either the supplier
 * invoice number, or supplier + bill date together.
 */
export class CheckVendorBillDuplicateDto {
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() supplierInvoiceNumber?: string;
  @IsOptional() @IsNumber() total?: number;
  @IsOptional() @IsString() billDate?: string;
}
