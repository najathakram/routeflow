import { PartialType } from "@nestjs/mapped-types";
import { IsNumber, Min } from "class-validator";
import { IsOptionalNotNull } from "../../common/validators/optional-not-null";
import { CreateRecurringInvoiceDto } from "./create-recurring-invoice.dto";

/**
 * REG-B92: the PATCH /recurring-invoices/:id body. Before this class the handler was
 * typed `Partial<CreateRecurringInvoiceDto>` — a mapped type erases to `Object` in
 * design:paramtypes, which the global ValidationPipe skips entirely, so the PATCH body
 * was never validated or whitelisted. Every create field is optional here; nested item
 * validation, ArrayMinSize(1) and the whitelist still apply when `items` is sent.
 * Deliberately no `isActive`: pause/resume are DELETE /:id and POST /:id/activate.
 */
export class UpdateRecurringInvoiceDto extends PartialType(CreateRecurringInvoiceDto) {
  // PartialType() re-adds @IsOptional(), which lets a JSON null skip @IsNumber() (row 602): redeclared so a
  // present null is refused (own metadata replaces the inherited kind).
  @IsOptionalNotNull() @IsNumber() @Min(0) discount?: number;
  @IsOptionalNotNull() @IsNumber() @Min(0) shippingFee?: number;
}
