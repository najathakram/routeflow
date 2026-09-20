import { Transform } from "class-transformer";
import { IsBoolean, IsString, MaxLength, MinLength } from "class-validator";

/** `PUT /platform-admin/entitlements/config-snapshot` — the live on/off switch (A2 decision 2). */
export class SetConfigSnapshotFlagDto {
  @IsBoolean()
  enabled!: boolean;

  /** Why — recorded in the audit row: this switches on unattended writes to tenant config. */
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;
}
