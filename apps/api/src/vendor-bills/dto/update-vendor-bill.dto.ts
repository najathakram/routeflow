import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { VendorBillItemDto } from "./create-vendor-bill.dto";

/**
 * PATCH /vendor-bills/:id body. F4-003: types the previously untyped `@Body()
 * any`. Mirrors the web UpdateVendorBillDto (supplierId?, billDate?, dueDate?,
 * notes?, items?). Only DRAFT bills are editable — enforced in the service.
 */
export class UpdateVendorBillDto {
  @IsOptional() @IsString() supplierId?: string;
  @IsOptional() @IsString() billDate?: string;
  @IsOptional() @IsString() dueDate?: string;
  /** Net-terms label as entered on the bill. Persisted verbatim — see
   * CreateVendorBillDto.termsLabel; the server does not derive dueDate from it. */
  @IsOptional() @IsString() @MaxLength(40) termsLabel?: string;
  @IsOptional() @IsString() notes?: string;
  /** The supplier's own invoice number; stored normalized and used for dedup. */
  @IsOptional() @IsString() supplierInvoiceNumber?: string;
  /** Sales tax as printed. Omit to keep the stored tax; totalOwed refolds it. */
  @IsOptional() @IsNumber() @Min(0) taxAmount?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VendorBillItemDto)
  items?: VendorBillItemDto[];
}
