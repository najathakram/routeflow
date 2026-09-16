import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * B451 gap 4: replaces `@Body() dto: any` (estimates.controller.ts), which
 * let the global ValidationPipe's whitelist/forbidNonWhitelisted/transform
 * run on nothing — the whole request body reached EstimatesService.create
 * verbatim, discount/taxAmount included, unvalidated.
 *
 * Field set is EXACTLY what the web client sends today
 * (apps/web/lib/api/estimates.ts CreateEstimateDto + the create-estimate
 * form in apps/web/app/(dashboard)/estimates/page.tsx) — no `discount` or
 * `taxAmount` field, because no caller sends them; a client that sends
 * either now gets a 400 (forbidNonWhitelisted) instead of an unvalidated
 * pass-through. `expiryDate` is kept as an accepted-and-ignored-by-neither
 * (still read by the service as a legacy fallback for `expiresAt`) — same
 * "deployed old bundle" precedent as CreateCreditNoteDto's issueDate/notes.
 */
export class CreateEstimateItemDto {
  @IsOptional() @IsString() productId?: string;
  @IsString() description: string;
  @IsNumber() @Min(0) qty: number;
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @IsOptional() @IsNumber() @Min(0) boxes?: number;
  @IsOptional() @IsNumber() @Min(0) pieces?: number;
}

export class CreateEstimateDto {
  @IsString() customerId: string;
  @IsOptional() @IsString() issueDate?: string;
  @IsOptional() @IsString() expiresAt?: string;
  /** Legacy alias for expiresAt — still read by an older deployed web bundle. */
  @IsOptional() @IsString() expiryDate?: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateEstimateItemDto)
  items: CreateEstimateItemDto[];
  @IsOptional() @IsString() notes?: string;
  @IsOptional() @IsString() terms?: string;
}
