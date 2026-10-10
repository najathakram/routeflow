import { IsBoolean, IsString, MinLength, MaxLength } from "class-validator";

/** `PUT /platform-admin/entitlements/config-snapshot` — the live on/off switch for automatic
 *  entitlement-config snapshot/restore on plan changes. One of the four production flags an
 *  agent never flips; the owner is the only caller. `reason` is required (not optional, unlike
 *  the neighbouring entitlements/mode switch) because this flag alone turns on UNATTENDED writes
 *  to tenant config data during a plan change. */
export class SetConfigSnapshotFlagDto {
  @IsBoolean()
  enabled!: boolean;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason!: string;
}
