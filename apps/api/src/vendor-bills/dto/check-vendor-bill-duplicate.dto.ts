import { IsNumber, IsOptional, IsString } from "class-validator";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";

/**
 * POST /vendor-bills/check-duplicate body — a read-only pre-flight of the same
 * guard `create()` enforces, so a client can warn before the operator finishes
 * keying a bill. Every field is optional: the matcher needs either the supplier
 * invoice number, or supplier + bill date together.
 */
export class CheckVendorBillDuplicateDto {
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() supplierInvoiceNumber?: string;
  @IsOptionalNotNull() @IsNumber() total?: number;
  @IsOptional() @IsString() billDate?: string;
}
