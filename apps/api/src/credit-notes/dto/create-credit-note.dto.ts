import { Type } from "class-transformer";
import {
  IsArray,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export class CreateCreditNoteLineDto {
  @IsString()
  @IsNotEmpty()
  invoiceItemId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  qty?: number;
}

export class CreateCreditNoteDto {
  @IsString()
  @IsNotEmpty()
  customerId!: string;

  /** Optional source invoice. Absent = a standalone credit for this customer. */
  @IsOptional()
  @IsString()
  invoiceId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCreditNoteLineDto)
  items?: CreateCreditNoteLineDto[];

  /** ISO date; the service additionally requires it to be in the future. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  // ---- Deprecated, accepted-and-ignored -------------------------------------------------
  // The global ValidationPipe runs forbidNonWhitelisted, and the deployed web bundle still
  // posts these two. They have no columns on CreditNote and the service already drops them.
  // Keeping them declared is what stops this DTO from 400-ing every in-flight client.
  // Remove once the old bundle has aged out of caches.
  @IsOptional()
  @IsString()
  issueDate?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
