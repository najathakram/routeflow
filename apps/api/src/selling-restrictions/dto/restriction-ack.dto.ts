import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";

/**
 * Row 510: one acknowledged line of a RESTRICTION_WARNING. `lineKey` is the server's opaque key from the warning
 * ("n:<index>" / "l:<lineId>" / "cr:<id>"); `reason` is bounded to 3..200 AFTER trim by the protocol
 * (restriction-warning.ts, a 400 RESTRICTION_OVERRIDE_REASON_INVALID), the DTO only caps the raw length.
 */
export class RestrictionOverrideDto {
  @IsString()
  @MaxLength(80)
  lineKey!: string;

  @IsString()
  @MaxLength(400)
  reason!: string;
}

/**
 * The top-level fields a staff write body may carry on resubmit after a 409 RESTRICTION_WARNING. Extended by every
 * body of a staff write that can sell a restricted product; the echo of `warningHash` is opaque to the client.
 */
export class RestrictionAckDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RestrictionOverrideDto)
  restrictionOverrides?: RestrictionOverrideDto[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  warningHash?: string;
}
