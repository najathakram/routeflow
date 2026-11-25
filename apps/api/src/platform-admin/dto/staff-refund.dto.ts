import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  Equals,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

/**
 * R-2 (SA-1297 ruling 8): the staff-refund request. There is NO amount field: the figure is always the latest yearly
 * payment's record, copied by the server. The global pipe's `forbidNonWhitelisted` answers a body that carries `amount` (or
 * any other unknown key) with a 400, and the invoice is never named either: it is always the route tenant's latest yearly payment.
 */
export class StaffRefundDto {
  @ApiProperty({
    description: "Staff confirm the yearly payment was refunded in full (must be true).",
  })
  @Equals(true)
  refundedInFull!: boolean;

  @ApiProperty({
    description: "Staff confirm the subscription was cancelled immediately (must be true).",
  })
  @Equals(true)
  cancelledImmediately!: boolean;

  @ApiProperty({ description: "The refund's reference from the payment provider's dashboard." })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  providerRef!: string;

  @ApiProperty({
    description: "The UTC day the refund was made in the provider's dashboard, YYYY-MM-DD.",
    example: "2026-11-15",
  })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsISO8601({ strict: true })
  refundDate!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}
