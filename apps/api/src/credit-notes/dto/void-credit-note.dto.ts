import { IsOptional, IsString, MaxLength } from "class-validator";

/** #2540: the optional reason for a void-with-reversal; it lands in the VOIDED audit row. */
export class VoidCreditNoteDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
