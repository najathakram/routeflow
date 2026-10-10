import { Type } from "class-transformer";
import {
  IsArray,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { CreateCreditNoteLineDto } from "./create-credit-note.dto";

/**
 * #2648 / SA-535(b): an amount/line edit of a credit note. Never applied in place: the old note is
 * voided with reversal and a new, unapplied note is minted for the same customer and the same
 * source invoice, in one transaction. Customer and invoice are not editable here.
 */
export class ReissueCreditNoteDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(1_000_000)
  amount!: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateCreditNoteLineDto)
  items?: CreateCreditNoteLineDto[];

  /** The new reason; the server prefixes "Replaces <old number>". Omitted = the old reason. */
  @IsOptional()
  @IsString()
  @MaxLength(450)
  reason?: string;

  /** Omitted = the old note's expiry (400 when that is already past); null = no expiry. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string | null;
}
