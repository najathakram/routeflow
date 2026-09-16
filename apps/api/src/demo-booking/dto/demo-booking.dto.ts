import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

/**
 * These arrive from the public marketing site with no authentication and no
 * tenant, so every field is bounded. `startsAt` is validated as an instant here
 * and re-checked against live availability in the service — a client is never
 * trusted to have picked a slot that is still free.
 */
export class CreateDemoBookingDto {
  @ApiProperty({ example: "Alex Morgan" })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: "alex@yourcompany.com" })
  @IsEmail()
  @MaxLength(160)
  email!: string;

  @ApiProperty({ example: "Parkside Wholesale" })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  company!: string;

  @ApiPropertyOptional({ example: "+1 555 0142" })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ description: "What the prospect wants the walkthrough to cover." })
  @IsOptional()
  @IsString()
  @MaxLength(1200)
  notes?: string;

  @ApiProperty({ description: "Slot start, UTC ISO-8601.", example: "2026-10-14T15:00:00.000Z" })
  @IsISO8601()
  startsAt!: string;

  @ApiProperty({ description: "The visitor's IANA time zone.", example: "America/Chicago" })
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9+_\-/]+$/, { message: "timeZone must be an IANA zone name" })
  timeZone!: string;

  @ApiPropertyOptional({ description: "Marketing page the booking started from." })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sourcePage?: string;
}

export class RescheduleDemoBookingDto {
  @ApiProperty({ description: "The booking's manage token, from the confirmation email." })
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  token!: string;

  @ApiProperty({ description: "New slot start, UTC ISO-8601." })
  @IsISO8601()
  startsAt!: string;
}

export class CancelDemoBookingDto {
  @ApiProperty({ description: "The booking's manage token, from the confirmation email." })
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  token!: string;

  @ApiPropertyOptional({ description: "Optional reason, shown to the RouteFlow team only." })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
