import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from "class-validator";

/** Quiet-hours + timezone config (P6-6). Start/end are "HH:MM" 24h strings;
 * `timezone: ""` clears it back to null. */
export class UpdateMessagingSettingsDto {
  @IsOptional()
  @IsBoolean()
  quietHoursEnabled?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "quietHoursStart must be in HH:MM format" })
  quietHoursStart?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: "quietHoursEnd must be in HH:MM format" })
  quietHoursEnd?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
