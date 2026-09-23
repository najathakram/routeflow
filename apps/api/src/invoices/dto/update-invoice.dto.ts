import { PartialType } from "@nestjs/mapped-types";
import { CreateInvoiceDto } from "./create-invoice.dto";

/**
 * B777: the PATCH /invoices/:id body. Before this class the handler was typed
 * `Partial<CreateInvoiceDto>` — a mapped TS type erases to `Object` in
 * design:paramtypes, which the global ValidationPipe (whitelist +
 * forbidNonWhitelisted, main.ts:145-149) skips entirely, so the PATCH body was
 * never validated or whitelisted: a string shippingFee silently rounded to 0
 * and desynced the linked order, and a negative discount was reachable from
 * the web edit page's number input (its `min={0}` never blocked a typed
 * negative value). Same erasure bug B92 already fixed — see
 * update-recurring-invoice.dto.ts. Every create field is optional here;
 * nested item validation (CreateInvoiceItemDto's own decorators, including
 * qty/unitPrice's @Min) and the whitelist still apply when `items` is sent.
 */
export class UpdateInvoiceDto extends PartialType(CreateInvoiceDto) {}
