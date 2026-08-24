import { IsBoolean, IsIn, IsInt, IsOptional, IsString } from "class-validator";
import { VALID_TERMS } from "../../system-config/dto/update-invoice-settings.dto";

// Canonical list plus "" so defaultTerms can be cleared — same list backing
// Customer.defaultPaymentTerms.
const VALID_SUPPLIER_TERMS = [...VALID_TERMS, ""];

export class CreateSupplierDto {
  @IsString() name: string;
  @IsOptional() @IsString() contactName?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() mobile?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() website?: string;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() leadTimeDays?: number;
  @IsOptional() @IsString() addressLine1?: string;
  @IsOptional() @IsString() addressLine2?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() zip?: string;
  @IsOptional() @IsString() country?: string;
  /** Net-terms label seeded onto a new vendor bill for this supplier ("Net 30",
   * "Due on Receipt", …). "" clears it. Bills still have no due-date-computation
   * machinery server side — the client derives Due Date = Bill Date + days. */
  @IsOptional()
  @IsIn(VALID_SUPPLIER_TERMS, {
    message: "defaultTerms must be one of: " + VALID_SUPPLIER_TERMS.join(", "),
  })
  defaultTerms?: string;
}
