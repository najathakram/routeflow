import { IsOptional, IsString, IsIn } from "class-validator";

const VALID_TERMS = ["Due on Receipt", "Net 15", "Net 30", "Net 45", "Net 60"];

export class UpdateInvoiceSettingsDto {
  @IsOptional()
  @IsString()
  @IsIn(VALID_TERMS, { message: "defaultTerms must be one of: " + VALID_TERMS.join(", ") })
  defaultTerms?: string;
}
