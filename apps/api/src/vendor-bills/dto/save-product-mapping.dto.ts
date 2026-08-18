import { IsOptional, IsString } from "class-validator";

/**
 * POST /vendor-bills/product-mappings body — the operator "remember this
 * match" correction from the invoice-scan review screen. `productId: null`
 * clears a previously learned mapping for this (supplierName, rawDescription)
 * pair; `IsOptional` lets that null through undisturbed.
 */
export class SaveProductMappingDto {
  @IsString() supplierName!: string;
  @IsString() rawDescription!: string;
  @IsOptional() @IsString() productId!: string | null;
}
