import { Transform } from "class-transformer";
import { IsBoolean, IsString, MaxLength, MinLength } from "class-validator";

/** `PATCH /platform-admin/config/auto-locks` (SA-775): pause / unpause every AUTOMATIC lock of PRODUCTION tenants.
 *  `reason` is required either way (the audit row carries it), trimmed, 3..500 characters. */
export class SetAutoLocksDto {
  @IsBoolean()
  paused!: boolean;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
