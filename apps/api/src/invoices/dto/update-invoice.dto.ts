import { OmitType, PartialType } from "@nestjs/mapped-types";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { CreateInvoiceDto, CreateInvoiceItemDto } from "./create-invoice.dto";

/**
 * SA-184/186: a line of the PATCH body. `id` is the stored InvoiceItem this line came from; the server
 * looks it up ONLY among this invoice's own rows (tenant-scoped) and refuses an unknown or foreign one
 * (400 "unknown line id"). It only ever selects a row: no column is written from it. An id-less line
 * (an old cached client) is matched by the full money tuple instead, until R1.1.
 * `unitsPerBox` is the operator's explicit pack for a CHANGED legacy line whose pack cannot be
 * recovered from its own snapshot or split (SA-189): written as the snapshot of THAT row only, ignored
 * on an unchanged line, refused when it disagrees with a recoverable pack or a unit line's own factor.
 */
export class UpdateInvoiceItemDto extends CreateInvoiceItemDto {
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsInt() @Min(2) unitsPerBox?: number;
}

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
 * nested item validation (UpdateInvoiceItemDto's own decorators, including
 * qty/unitPrice's @Min) and the whitelist still apply when `items` is sent.
 */
export class UpdateInvoiceDto extends PartialType(OmitType(CreateInvoiceDto, ["items"] as const)) {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => UpdateInvoiceItemDto)
  items?: UpdateInvoiceItemDto[];
}
