import { IsArray, IsOptional, IsString, ValidateNested } from "class-validator";
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
  @IsOptional() @IsString() notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VendorBillItemDto)
  items?: VendorBillItemDto[];
}
